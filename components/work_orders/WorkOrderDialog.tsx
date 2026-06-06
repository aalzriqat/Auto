"use client";

import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const taskSchema = z.object({
  id: z.string(),
  description: z.string().min(1, "Description is required"),
  partsCost: z.coerce.number().min(0),
  laborCost: z.coerce.number().min(0),
  mechanicName: z.string().optional(),
  completed: z.boolean(),
});

const workOrderSchema = z.object({
  title: z.string().min(1, "Title is required"),
  status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]),
  tasks: z.array(taskSchema).min(1, "At least one task is required"),
  notes: z.string().optional(),
});

type WorkOrderFormValues = z.infer<typeof workOrderSchema>;

interface WorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: Id<"vehicles">;
  workOrder?: any | null;
}

export function WorkOrderDialog({ open, onOpenChange, vehicleId, workOrder }: WorkOrderDialogProps) {
  const { activeOrgId } = useOrg();

  const createWO = useMutation(api.workOrders.create);
  const updateWO = useMutation(api.workOrders.update);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<WorkOrderFormValues>({
    resolver: zodResolver(workOrderSchema),
    defaultValues: {
      title: "",
      status: "OPEN",
      tasks: [{ id: crypto.randomUUID(), description: "", partsCost: 0, laborCost: 0, mechanicName: "", completed: false }],
      notes: "",
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "tasks",
  });

  useEffect(() => {
    if (workOrder && open) {
      form.reset({
        title: workOrder.title,
        status: workOrder.status,
        tasks: workOrder.tasks?.length ? workOrder.tasks : [{ id: crypto.randomUUID(), description: "", partsCost: 0, laborCost: 0, mechanicName: "", completed: false }],
        notes: workOrder.notes || "",
      });
    } else if (open && !workOrder) {
      form.reset({
        title: "",
        status: "OPEN",
        tasks: [{ id: crypto.randomUUID(), description: "", partsCost: 0, laborCost: 0, mechanicName: "", completed: false }],
        notes: "",
      });
    }
  }, [workOrder, open, form]);

  const watchTasks = form.watch("tasks");
  const totalCost = watchTasks.reduce((sum, t) => sum + (Number(t.partsCost) || 0) + (Number(t.laborCost) || 0), 0);

  const onSubmit = async (values: WorkOrderFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      if (workOrder) {
        await updateWO({
          orgId: activeOrgId,
          workOrderId: workOrder._id,
          title: values.title,
          status: values.status,
          tasks: values.tasks,
          notes: values.notes,
        });
        toast.success("Work order updated successfully");
      } else {
        await createWO({
          orgId: activeOrgId,
          vehicleId,
          title: values.title,
          status: values.status,
          tasks: values.tasks,
          notes: values.notes,
        });
        toast.success("Work order created successfully!");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to save work order");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{workOrder ? "Edit Work Order" : "New Work Order"}</DialogTitle>
          <DialogDescription>
            {workOrder 
              ? "Update tasks and status. Completing this will sync the total cost to expenses." 
              : "Track repairs, parts, and labor costs for this vehicle."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Work Order Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Brake Replacement & Alignment" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="OPEN">Open</SelectItem>
                        <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                        <SelectItem value="COMPLETED">Completed</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="bg-muted p-4 rounded-lg space-y-4">
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-semibold">Service Tasks</h4>
                <Button type="button" variant="outline" size="sm" onClick={() => append({ id: crypto.randomUUID(), description: "", partsCost: 0, laborCost: 0, mechanicName: "", completed: false })}>
                  <Plus className="h-4 w-4 mr-2" /> Add Task
                </Button>
              </div>

              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-12 gap-3 items-end border-b pb-4 border-border/50">
                  <FormField
                    control={form.control}
                    name={`tasks.${index}.description`}
                    render={({ field }) => (
                      <FormItem className="col-span-5">
                        <FormLabel className="text-xs">Task Description</FormLabel>
                        <FormControl><Input placeholder="e.g. Front brake pads" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`tasks.${index}.partsCost`}
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel className="text-xs">Parts Cost ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`tasks.${index}.laborCost`}
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel className="text-xs">Labor Cost ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`tasks.${index}.mechanicName`}
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel className="text-xs">Mechanic</FormLabel>
                        <FormControl><Input placeholder="Name" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="col-span-1 pb-2 flex justify-center">
                    <Button type="button" variant="ghost" size="icon" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => remove(index)} disabled={fields.length === 1}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}

              <div className="flex justify-end pt-2">
                <span className="font-semibold text-lg">Total Cost: <span className="text-primary">{totalCost.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</span></span>
              </div>
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Additional Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any extra details about this work order..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : workOrder ? "Save Changes" : "Create Work Order"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
