import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const taskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  dueDate: z.date({ required_error: "Due date is required" }),
  assignedTo: z.string().min(1, "Assignee is required"),
  customerId: z.string().optional(),
  vehicleId: z.string().optional(),
  communicationMethod: z.enum(["PHONE", "EMAIL", "FAX", "none"]).optional(),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),
});

export type TaskFormValues = z.infer<typeof taskSchema>;

export interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task?: Doc<"tasks"> | null;
}
