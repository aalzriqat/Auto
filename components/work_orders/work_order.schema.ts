import * as z from "zod";
import { Id } from "@/convex/_generated/dataModel";

export const taskSchema = z.object({
  id: z.string(),
  description: z.string().min(1, "Description is required"),
  partsCost: z.coerce.number().min(0),
  laborCost: z.coerce.number().min(0),
  mechanicName: z.string().optional(),
  completed: z.boolean(),
});

export const workOrderSchema = z.object({
  title: z.string().min(1, "Title is required"),
  status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]),
  tasks: z.array(taskSchema).min(1, "At least one task is required"),
  notes: z.string().optional(),
  // SCRUM-389. Only asked for on a SOURCED vehicle; the server requires it
  // there before the work order can complete, and accepts SHOWROOM only.
  costBearer: z.enum(["SHOWROOM", "SUPPLIER"]).optional(),
});

export type WorkOrderFormValues = z.infer<typeof workOrderSchema>;

export interface WorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: Id<"vehicles">;
  /** SCRUM-389: a SOURCED vehicle's completed work order needs an explicit cost bearer. */
  vehicleSourceType?: "STOCK" | "SOURCED";
  workOrder?: any | null;
}
