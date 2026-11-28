import * as z from "zod";
import { NON_PREPAID_EXPENSE_CATEGORIES } from "@autoflow/shared";
import { Doc } from "@/convex/_generated/dataModel";

export const expenseSchema = z
  .object({
    title: z.string().min(1, "Title is required"),
    amount: z.coerce.number().min(0, "Amount must be positive"),
    taxAmount: z.coerce.number().min(0, "VAT amount cannot be negative").optional(),
    date: z.string().min(1, "Date is required"),
    category: z.enum(NON_PREPAID_EXPENSE_CATEGORIES),
    vehicleId: z.string().optional(),
    status: z.enum(["PENDING", "PAID"]),
    vendor: z.string().optional(),
    vendorSupplierId: z.string().optional(),
    payerId: z.string().optional(),
    paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
    bankAccountId: z.string().optional(),
    notes: z.string().optional(),
    isPrepaid: z.boolean().optional(),
    amortizationMonths: z.coerce.number().int().min(1).max(600).optional(),
    // When the covered service/coverage period actually starts, if later than
    // the payment date (e.g. insurance paid in June covering July onward).
    // Left empty, recognition begins the month the expense was paid.
    amortizationStartDate: z.string().optional(),
    // SCRUM-389. Offered only for a SOURCED vehicle; the server is the
    // authority on whether SUPPLIER is allowed.
    costBearer: z.enum(["SHOWROOM", "SUPPLIER"]).optional(),
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

/**
 * What the expense assistant proposes (SCRUM-1039), as `aiAssistant.getExpenseProposal`
 * returns it. Category and payment method are plain strings here: the form only
 * takes the ones it offers and leaves the rest at its defaults.
 */
export interface ExpenseProposalValues {
  amount: number;
  taxAmount?: number;
  category: string;
  /** "YYYY-MM-DD", the same shape as the form's date field. */
  date: string;
  title: string;
  notes?: string;
  vendorName?: string;
  paymentMethod?: string;
}

export interface ExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Doc<"expenses"> | null;
  /**
   * Create mode only: fields the assistant proposed, applied once when the form
   * opens. The staff member checks them and saves with the normal button. Ignored
   * when `expense` is given.
   */
  assistantProposal?: ExpenseProposalValues | null;
}
