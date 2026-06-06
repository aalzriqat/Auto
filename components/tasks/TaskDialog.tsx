"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const taskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  dueDate: z.date({ required_error: "Due date is required" }),
  assignedTo: z.string().min(1, "Assignee is required"),
  customerId: z.string().optional(),
  communicationMethod: z.enum(["PHONE", "EMAIL", "FAX", "none"]).optional(),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),
});

type TaskFormValues = z.infer<typeof taskSchema>;

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task?: Doc<"tasks"> | null;
}

export function TaskDialog({ open, onOpenChange, task }: TaskDialogProps) {
  const { activeOrgId } = useOrg();
  
  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const customers = useQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      title: "",
      description: "",
      dueDate: new Date(),
      assignedTo: "",
      customerId: "none",
      communicationMethod: "none",
      status: "PENDING",
    },
  });

  useEffect(() => {
    if (task && open) {
      const date = new Date(task.dueDate);
      const tzOffset = date.getTimezoneOffset() * 60000;
      const localISOTime = new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
      
      form.reset({
        title: task.title,
        description: task.description || "",
        dueDate: new Date(task.dueDate),
        assignedTo: task.assignedTo,
        customerId: task.customerId || "none",
        communicationMethod: (task.communicationMethod as any) || "none",
        status: task.status,
      });
    } else if (open && !task) {
      const myMembership = memberships?.find(m => m.userId);
      
      form.reset({
        title: "",
        description: "",
        dueDate: new Date(),
        assignedTo: myMembership ? myMembership.userId : "",
        customerId: "none",
        communicationMethod: "none",
        status: "PENDING",
      });
    }
  }, [task, open, form, memberships]);

  const onSubmit = async (values: TaskFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const dueDate = values.dueDate.getTime();
      const status = values.status as "PENDING" | "COMPLETED" | "CANCELLED";
      const customerId = values.customerId === "none" ? undefined : (values.customerId as Id<"customers">);
      const communicationMethod = values.communicationMethod === "none" ? undefined : (values.communicationMethod as "PHONE" | "EMAIL" | "FAX");

      if (task) {
        await updateTask({
          orgId: activeOrgId,
          taskId: task._id,
          title: values.title,
          description: values.description,
          dueDate: dueDate,
          assignedTo: values.assignedTo as Id<"users">,
          customerId: customerId === undefined ? null : customerId,
          status: status,
          communicationMethod: communicationMethod,
        });
        toast.success("Task updated successfully");
      } else {
        await createTask({
          orgId: activeOrgId,
          title: values.title,
          description: values.description,
          dueDate: dueDate,
          assignedTo: values.assignedTo as Id<"users">,
          customerId: customerId,
          status: status,
          communicationMethod: communicationMethod,
        });
        toast.success("Task created successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save task");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? "Edit Task" : "Create Task"}</DialogTitle>
          <DialogDescription>
            {task 
              ? "Update task details." 
              : "Schedule a new task and assign it to a team member."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Task Title <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Call customer for follow-up" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="assignedTo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assign To <span className="text-red-500">*</span></FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select team member" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {memberships?.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.userName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date & Time <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <DateTimePicker value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Related Customer</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select customer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">-- General Task (No Customer) --</SelectItem>
                        {customers?.map((c) => (
                          <SelectItem key={c._id} value={c._id}>
                            {c.firstName} {c.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="communicationMethod"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Preferred Communication</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select method" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">-- Not Specified --</SelectItem>
                        <SelectItem value="PHONE">Phone</SelectItem>
                        <SelectItem value="EMAIL">Email</SelectItem>
                        <SelectItem value="FAX">Fax</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PENDING">Pending</SelectItem>
                        <SelectItem value="COMPLETED">Completed</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Description / Notes</FormLabel>
                    <FormControl>
                      <textarea 
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder="Task details..." 
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : task ? "Save Changes" : "Create Task"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
