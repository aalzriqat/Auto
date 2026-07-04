import { z } from "zod";

export const CreateExpenseSchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  branchId: z.string().optional(),
  vehicleId: z.string().optional(),
  title: z.string().min(1, "Title is required").max(100, "Title is too long"),
  amount: z.number().positive("Amount must be greater than zero"),
  date: z.number(),
  category: z.enum([
    "REPAIR",
    "MAINTENANCE",
    "DETAILING",
    "TRANSPORT",
    "MARKETING",
    "OFFICE",
    "SALARIES",
    "RENT",
    "UTILITIES",
    "FEES",
    "PREPAID",
    "OTHER",
  ]),
  isPrepaid: z.boolean().optional(),
  amortizationMonths: z.number().min(1).optional(),
  status: z.enum(["PENDING", "PAID"]).optional(),
  vendor: z.string().optional(),
  payerId: z.string().optional(),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]).optional(),
  notes: z.string().max(1000).optional(),
});

export const UpdateExpenseSchema = CreateExpenseSchema.partial().extend({
  orgId: z.string().min(1, "Organization ID is required"),
  expenseId: z.string().min(1, "Expense ID is required"),
});
