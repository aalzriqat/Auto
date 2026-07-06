import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const expenseSchema = z.object({
  title: z.string().min(1, "Title is required"),
  amount: z.coerce.number().min(0, "Amount must be positive"),
  taxAmount: z.coerce.number().min(0, "VAT amount cannot be negative").optional(),
  date: z.string().min(1, "Date is required"),
  category: z.enum(["REPAIR", "MAINTENANCE", "DETAILING", "TRANSPORT", "MARKETING", "OFFICE", "OTHER"]),
  vehicleId: z.string().optional(),
  status: z.enum(["PENDING", "PAID"]),
  vendor: z.string().optional(),
  payerId: z.string().optional(),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
  notes: z.string().optional(),
});

export type ExpenseFormValues = z.infer<typeof expenseSchema>;

export interface ExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Doc<"expenses"> | null;
}
