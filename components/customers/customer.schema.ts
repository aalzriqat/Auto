import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const customerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email format").optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  nationalId: z.string().optional(),
  address: z.string().optional(),
});

export type CustomerFormValues = z.infer<typeof customerSchema>;

export interface CustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: Doc<"customers"> | null;
}
