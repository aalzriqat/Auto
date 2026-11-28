import { isNonPrepaidExpenseCategory } from "@autoflow/shared";
import type { ExpenseFormValues, ExpenseProposalValues } from "./expense.schema";

/** The payment methods the expense form offers (expense.schema.ts). */
const FORM_PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"] as const;
type FormPaymentMethod = (typeof FORM_PAYMENT_METHODS)[number];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isFormPaymentMethod(value: unknown): value is FormPaymentMethod {
  return typeof value === "string" && FORM_PAYMENT_METHODS.some((method) => method === value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The values a new expense form starts with: today's date, Other, Paid in cash,
 * and every other field empty. Moved here unchanged from ExpenseDialog's create
 * branch (SCRUM-1039) so the assistant's proposal can be laid over it.
 *
 * With a proposal, only title, amount, VAT, date, category, vendor, payment
 * method and notes can come from it. Status, payer, bank account, vehicle, cost
 * bearer and the prepaid fields always keep these defaults: those are the staff
 * member's decisions. A value the form cannot show (a category or method it
 * does not offer, a malformed date, a negative amount) is dropped and the
 * default stays.
 */
export function newExpenseFormValues(proposal?: ExpenseProposalValues | null): ExpenseFormValues {
  const values: ExpenseFormValues = {
    title: "",
    amount: 0,
    taxAmount: 0,
    date: new Date().toISOString().split("T")[0],
    category: "OTHER",
    vehicleId: "none",
    status: "PAID",
    vendor: "",
    vendorSupplierId: "",
    payerId: "none",
    paymentMethod: "CASH",
    bankAccountId: "",
    notes: "",
    isPrepaid: false,
    amortizationMonths: undefined,
    amortizationStartDate: "",
    costBearer: "SHOWROOM",
  };
  if (!proposal) return values;
  if (typeof proposal.title === "string" && proposal.title.trim()) values.title = proposal.title;
  if (isNonNegativeNumber(proposal.amount)) values.amount = proposal.amount;
  if (isNonNegativeNumber(proposal.taxAmount)) values.taxAmount = proposal.taxAmount;
  if (typeof proposal.date === "string" && ISO_DAY.test(proposal.date)) values.date = proposal.date;
  if (isNonPrepaidExpenseCategory(proposal.category)) values.category = proposal.category;
  if (typeof proposal.vendorName === "string" && proposal.vendorName.trim()) values.vendor = proposal.vendorName;
  if (isFormPaymentMethod(proposal.paymentMethod)) values.paymentMethod = proposal.paymentMethod;
  if (typeof proposal.notes === "string" && proposal.notes.trim()) values.notes = proposal.notes;
  return values;
}

/** Which proposed values the form had to leave at its defaults, for the notice. */
export function unsupportedProposalFields(proposal?: ExpenseProposalValues | null): {
  category: boolean;
  paymentMethod: boolean;
} {
  if (!proposal) return { category: false, paymentMethod: false };
  return {
    category: !isNonPrepaidExpenseCategory(proposal.category),
    paymentMethod: proposal.paymentMethod !== undefined && !isFormPaymentMethod(proposal.paymentMethod),
  };
}
