import * as z from "zod";
import { Doc, Id } from "@/convex/_generated/dataModel";
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

/**
 * The leads page passes the hydrated row from `api.leads.list` (flat
 * `customerName`/`vehicleSummary`/… fields); `api.leads.get` returns nested
 * objects instead. Both shapes are accepted so the dialog can always name the
 * lead's current customer, vehicle and salesperson — see `withCurrentOption`
 * in LeadDialog.tsx for why that matters.
 */
export interface LeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCustomerId?: Id<"customers"> | null;
  lead?:
    | (Doc<"leads"> & {
        customer?: Doc<"customers"> | null;
        vehicle?: Doc<"vehicles"> | null;
        assignedUser?: { _id: string; name?: string; email?: string } | null;
        customerName?: string | null;
        phone?: string | null;
        email?: string | null;
        vehicleSummary?: string | null;
        assignedUserName?: string | null;
      })
    | null;
}
