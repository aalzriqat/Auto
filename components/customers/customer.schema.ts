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

/**
 * Editing an existing customer allows an empty surname.
 *
 * Contacts created from a social profile can legitimately have only one name —
 * an Instagram handle, or a person who goes by a mononym. Requiring a surname
 * on edit meant a salesperson could not update such a customer's phone or
 * address without inventing a family name for them. Creating a customer by
 * hand still requires both.
 */
export const customerEditSchema = customerSchema.extend({
  lastName: z.string(),
});
