import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const expenseSchema = z
  .object({
    title: z.string().min(1, "Title is required"),
    amount: z.coerce.number().min(0, "Amount must be positive"),
    taxAmount: z.coerce.number().min(0, "VAT amount cannot be negative").optional(),
    date: z.string().min(1, "Date is required"),
    category: z.enum([
      "REPAIR",
      "MAINTENANCE",
      "DETAILING",
      "TRANSPORT",
      "MARKETING",
      "OFFICE",
      "RENT",
      "UTILITIES",
      "SALARIES",
      "FEES",
      "OTHER",
    ]),
    vehicleId: z.string().optional(),
    status: z.enum(["PENDING", "PAID"]),
    vendor: z.string().optional(),
    payerId: z.string().optional(),
    paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
    notes: z.string().optional(),
    isPrepaid: z.boolean().optional(),
    amortizationMonths: z.coerce.number().int().min(1).max(600).optional(),
    // When the covered service/coverage period actually starts, if later than
    // the payment date (e.g. insurance paid in June covering July onward).
    // Left empty, recognition begins the month the expense was paid.
    amortizationStartDate: z.string().optional(),
  })
  .refine((v) => !v.isPrepaid || (v.amortizationMonths !== undefined && v.amortizationMonths >= 1), {
    message: "Enter how many months to amortize over",
    path: ["amortizationMonths"],
  })
  // Month-level comparison (not day-level): recognition is bucketed by
  // calendar month, so a start date a few days earlier in the same month as
  // the expense changes nothing — the backend (expenses.ts
  // normalizePrepaidFields) applies the same rule and is the real authority.
  .refine(
    (v) =>
      !v.isPrepaid ||
      !v.amortizationStartDate ||
      !v.date ||
      v.amortizationStartDate.slice(0, 7) >= v.date.slice(0, 7),
    {
      message: "Amortization can't start before the month the expense was paid",
      path: ["amortizationStartDate"],
    }
  );

export type ExpenseFormValues = z.infer<typeof expenseSchema>;

export interface ExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Doc<"expenses"> | null;
}
