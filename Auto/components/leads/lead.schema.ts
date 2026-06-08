import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";
import { LEAD_STAGES } from "@/convex/constants";

export const leadSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  vehicleId: z.string().optional().or(z.literal("")),
  assignedUserId: z.string().optional().or(z.literal("")),
  source: z.string().min(1, "Source is required"),
  stage: z.enum([
    LEAD_STAGES[0],
    LEAD_STAGES[1],
    LEAD_STAGES[2],
    LEAD_STAGES[3],
    LEAD_STAGES[4],
    LEAD_STAGES[5],
    LEAD_STAGES[6],
    LEAD_STAGES[7],
  ]),
  notes: z.string().optional(),
});

export type LeadFormValues = z.infer<typeof leadSchema>;

export interface LeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead?: (Doc<"leads"> & { customer?: any; vehicle?: any; assignedUser?: any }) | null;
}
