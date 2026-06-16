"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
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
import { SearchableSelect } from "@/components/ui/searchable-select";

import { taskSchema, TaskFormValues, TaskDialogProps } from "./task.schema";


export function TaskDialog({ open, onOpenChange, task }: TaskDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const vehicles = useQuery(api.vehicles.listAll, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<z.infer<typeof taskSchema>>({
    resolver: zodResolver(taskSchema as any),
    defaultValues: {
      title: "",
      description: "",
      dueDate: new Date(),
      assignedTo: "",
      customerId: "none",
      vehicleId: "none",
      communicationMethod: "none",
      priority: "none",
      status: "PENDING",
    },
  });

  useEffect(() => {
    if (task && open) {
      form.reset({
        title: task.title,
        description: task.description || "",
        dueDate: new Date(task.dueDate),
        assignedTo: task.assignedTo,
        customerId: task.customerId || "none",
        vehicleId: task.vehicleId || "none",
        communicationMethod: (task.communicationMethod as any) || "none",
        priority: ((task as any).priority as any) || "none",
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
        vehicleId: "none",
        communicationMethod: "none",
        priority: "none",
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
      const vehicleId = values.vehicleId === "none" ? undefined : (values.vehicleId as Id<"vehicles">);
      const communicationMethod = values.communicationMethod === "none" ? undefined : (values.communicationMethod as "PHONE" | "EMAIL" | "FAX");
      const priority = (values as any).priority === "none" ? undefined : ((values as any).priority as "HIGH" | "MEDIUM" | "LOW");

      if (task) {
        await updateTask({
          orgId: activeOrgId,
          taskId: task._id,
          title: values.title,
          description: values.description,
          dueDate: dueDate,
          assignedTo: values.assignedTo as Id<"users">,
          customerId: customerId === undefined ? null : customerId,
          vehicleId: vehicleId === undefined ? null : vehicleId,
          status: status,
          priority: priority,
          communicationMethod: communicationMethod,
        });
        toast.success(t("TaskUpdatedSuccess" as any) || "Task updated successfully");
      } else {
        await createTask({
          orgId: activeOrgId,
          title: values.title,
          description: values.description,
          dueDate: dueDate,
          assignedTo: values.assignedTo as Id<"users">,
          customerId: customerId,
          vehicleId: vehicleId,
          status: status,
          priority: priority,
          communicationMethod: communicationMethod,
        });
        toast.success(t("TaskCreatedSuccess" as any) || "Task created successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || (t("TaskSaveFail" as any) || "Failed to save task"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? (t("EditTask" as any) || "Edit Task") : (t("CreateTask" as any) || "Create Task")}</DialogTitle>
          <DialogDescription>
            {task
              ? (t("UpdateTaskDesc" as any) || "Update task details.")
              : (t("CreateTaskDesc" as any) || "Schedule a new task and assign it to a team member.")}
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
                    <FormLabel>{t("TaskTitle" as any) || "Task Title"} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder={t("TaskTitlePlaceholder" as any) || "e.g. Call customer for follow-up"} {...field} />
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
                    <FormLabel>{t("AssignTo" as any) || "Assign To"} <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectTeamMember" as any) || "Select team member"}
                        options={memberships?.map((m) => ({
                          value: m.userId,
                          label: m.userName,
                          subLabel: m.roleName || undefined,
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("DueDateTime" as any) || "Due Date & Time"} <span className="text-red-500">*</span></FormLabel>
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
                    <FormLabel>{t("RelatedCustomer" as any) || "Related Customer"}</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectCustomer" as any) || "Select customer"}
                        noneLabel={t("GeneralTaskNoCustomer" as any) || "-- General Task (No Customer) --"}
                        options={customers?.map((c) => ({
                          value: c._id,
                          label: `${c.firstName} ${c.lastName}`,
                          subLabel: c.phone || undefined,
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vehicleId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("RelatedVehicle" as any) || "Related Vehicle"}</FormLabel>
                    <FormControl>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={t("SelectVehicle" as any) || "Select vehicle"}
                        noneLabel={t("GeneralTaskNoVehicle" as any) || "-- General Task (No Vehicle) --"}
                        options={vehicles?.map((v) => ({
                          value: v._id,
                          label: `${v.year} ${v.make} ${v.model}`,
                          subLabel: v.vin,
                        })) ?? []}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="communicationMethod"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("PreferredCommunication" as any) || "Preferred Communication"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectMethod" as any) || "Select method"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t("NotSpecified" as any) || "-- Not Specified --"}</SelectItem>
                        <SelectItem value="PHONE">{t("Phone" as any) || "Phone"}</SelectItem>
                        <SelectItem value="EMAIL">{t("Email" as any) || "Email"}</SelectItem>
                        <SelectItem value="FAX">{t("Fax" as any) || "Fax"}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name={"priority" as any}
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Priority</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select priority" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">-- Not Set --</SelectItem>
                        <SelectItem value="HIGH">🔴 High</SelectItem>
                        <SelectItem value="MEDIUM">🟡 Medium</SelectItem>
                        <SelectItem value="LOW">🟢 Low</SelectItem>
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
                    <FormLabel>{t("Status" as any) || "Status"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectStatus" as any) || "Select status"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PENDING">{t("TaskPending" as any) || "Pending"}</SelectItem>
                        <SelectItem value="COMPLETED">{t("TaskCompleted" as any) || "Completed"}</SelectItem>
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
                    <FormLabel>{t("DescriptionNotes" as any) || "Description / Notes"}</FormLabel>
                    <FormControl>
                      <textarea
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder={t("TaskDetailsPlaceholder" as any) || "Task details..."}
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
                {t("Cancel" as any) || "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (t("Saving" as any) || "Saving...") : task ? (t("SaveChanges" as any) || "Save Changes") : (t("CreateTask" as any) || "Create Task")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
