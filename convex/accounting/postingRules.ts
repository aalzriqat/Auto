import { SYSTEM_KEYS, SystemKey } from "../utils/defaultChart";
import { scaleForCurrency } from "../utils/money";

export type EventType =
  | "DEPOSIT_RECEIVED"
  | "DEPOSIT_APPLIED"
  | "DEPOSIT_REFUNDED"
  | "DEPOSIT_FORFEITED"
  | "SALE_COMPLETED"
  | "SALE_CANCELLED"
  | "COLLECTION_PAYMENT"
  | "EXPENSE_POSTED"
  | "CHEQUE_RECEIVED"
  | "CHEQUE_DEPOSITED"
  | "CHEQUE_CLEARED"
  | "CHEQUE_RETURNED"
  | "COMMISSION_ACCRUED"
  | "COMMISSION_PAID"
  | "FINANCE_DISBURSED"
  | "PAYMENT_LINK_RECEIVED"
  | "JOURNAL_REVERSAL";

export const ALL_EVENT_TYPES = new Set<string>([
  "DEPOSIT_RECEIVED", "DEPOSIT_APPLIED", "DEPOSIT_REFUNDED", "DEPOSIT_FORFEITED",
  "SALE_COMPLETED", "SALE_CANCELLED", "COLLECTION_PAYMENT", "EXPENSE_POSTED",
  "CHEQUE_RECEIVED", "CHEQUE_DEPOSITED", "CHEQUE_CLEARED", "CHEQUE_RETURNED",
  "COMMISSION_ACCRUED", "COMMISSION_PAID",
  "FINANCE_DISBURSED", "PAYMENT_LINK_RECEIVED",
  "JOURNAL_REVERSAL",
]);

export interface LineSpec {
  accountSystemKey: SystemKey;
  debitMinor: number;
  creditMinor: number;
  description?: string;
  vehicleId?: string;
  customerId?: string;
  salespersonId?: string;
  cashierId?: string;
  financeCompanyId?: string;
}

export interface RuleResult {
  lines: LineSpec[];
  memo: string;
  category: "SYSTEM" | "REVERSAL" | "ADJUSTMENT";
}

function cashAccountKey(
  method: string | undefined,
  opts?: { defaultCash?: SystemKey }
): SystemKey {
  if (method === "CHEQUE") return SYSTEM_KEYS.CHEQUES_IN_HAND;
  if (method === "BANK_TRANSFER") return SYSTEM_KEYS.BANK_ACCOUNT;
  return opts?.defaultCash ?? SYSTEM_KEYS.CASH_ON_HAND;
}

function line(
  accountSystemKey: SystemKey,
  debitMinor: number,
  creditMinor: number,
  description?: string,
  dims?: Partial<Pick<LineSpec, "vehicleId" | "customerId" | "salespersonId" | "cashierId" | "financeCompanyId">>
): LineSpec {
  return { accountSystemKey, debitMinor, creditMinor, description, ...dims };
}

// ─── Payload interfaces ───────────────────────────────────────────────────────

export interface DepositReceivedPayload {
  depositId: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  customerId: string;
}

export interface DepositAppliedPayload {
  depositId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  saleId?: string;
}

export interface DepositRefundedPayload {
  depositId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
}

export interface DepositForfeitedPayload {
  depositId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
}

export interface SaleCompletedPayload {
  saleId: string;
  saleAmountMinor: number;
  costMinor?: number;
  currency: string;
  customerId: string;
  vehicleId: string;
  salespersonId?: string;
  taxMinor?: number;
}

export interface CollectionPaymentPayload {
  paymentId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  paymentMethod?: string;
}

export interface ExpensePostedPayload {
  expenseId: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
}

export interface CommissionAccruedPayload {
  saleId: string;
  amountMinor: number;
  currency: string;
  salespersonId: string;
}

export interface CommissionPaidPayload {
  saleId: string;
  amountMinor: number;
  currency: string;
  salespersonId: string;
}

export interface ChequeReceivedPayload {
  chequeId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
}

export interface ChequeClearedPayload {
  chequeId: string;
  amountMinor: number;
  currency: string;
}

export interface ChequeReturnedPayload {
  chequeId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  bankFeeMinor?: number;
}

// ─── Rule functions ───────────────────────────────────────────────────────────

export function ruleDepositReceived(p: DepositReceivedPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, "Deposit received", { customerId: p.customerId }),
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, 0, p.amountMinor, "Customer deposit liability", { customerId: p.customerId }),
    ],
    memo: "Deposit received",
    category: "SYSTEM",
  };
}

export function ruleDepositApplied(p: DepositAppliedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, p.amountMinor, 0, "Deposit liability released", { customerId: p.customerId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.amountMinor, "Applied to AR", { customerId: p.customerId }),
    ],
    memo: "Deposit applied to sale",
    category: "SYSTEM",
  };
}

export function ruleDepositRefunded(p: DepositRefundedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, p.amountMinor, 0, "Deposit liability released", { customerId: p.customerId }),
      line(SYSTEM_KEYS.CASH_ON_HAND, 0, p.amountMinor, "Deposit refund paid out", { customerId: p.customerId }),
    ],
    memo: "Deposit refunded to customer",
    category: "SYSTEM",
  };
}

export function ruleDepositForfeited(p: DepositForfeitedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, p.amountMinor, 0, "Deposit forfeited", { customerId: p.customerId }),
      line(SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME, 0, p.amountMinor, "Forfeiture income", { customerId: p.customerId }),
    ],
    memo: "Deposit forfeited",
    category: "SYSTEM",
  };
}

export function ruleSaleCompleted(p: SaleCompletedPayload): RuleResult {
  const revenueMinor = p.taxMinor ? p.saleAmountMinor - p.taxMinor : p.saleAmountMinor;
  const dims = { customerId: p.customerId, vehicleId: p.vehicleId, salespersonId: p.salespersonId };
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.saleAmountMinor, 0, "Sale receivable", dims),
    line(SYSTEM_KEYS.SALES_REVENUE, 0, revenueMinor, "Vehicle sale revenue", dims),
  ];
  if (p.taxMinor && p.taxMinor > 0) {
    lines.push(line(SYSTEM_KEYS.SALES_TAX_PAYABLE, 0, p.taxMinor, "Sales tax payable", { vehicleId: p.vehicleId }));
  }
  if (p.costMinor && p.costMinor > 0) {
    lines.push(line(SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, p.costMinor, 0, "Cost of vehicle sold", { vehicleId: p.vehicleId }));
    lines.push(line(SYSTEM_KEYS.VEHICLE_INVENTORY, 0, p.costMinor, "Inventory relief", { vehicleId: p.vehicleId }));
  }
  return { lines, memo: "Vehicle sale completed", category: "SYSTEM" };
}

export function ruleCollectionPayment(p: CollectionPaymentPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, "Payment received", { customerId: p.customerId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.amountMinor, "AR settled", { customerId: p.customerId }),
    ],
    memo: "Collection payment received",
    category: "SYSTEM",
  };
}

export function ruleExpensePosted(p: ExpensePostedPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.COMMISSION_EXPENSE, p.amountMinor, 0, "General expense"),
      line(cashKey, 0, p.amountMinor, "Cash payment"),
    ],
    memo: "Expense posted",
    category: "SYSTEM",
  };
}

export function ruleChequeReceived(p: ChequeReceivedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CHEQUES_IN_HAND, p.amountMinor, 0, "Cheque received", { customerId: p.customerId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.amountMinor, "AR settled", { customerId: p.customerId }),
    ],
    memo: "Cheque received",
    category: "SYSTEM",
  };
}

export function ruleChequeClear(p: ChequeClearedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.BANK_ACCOUNT, p.amountMinor, 0, "Cheque cleared"),
      line(SYSTEM_KEYS.CHEQUES_UNDER_COLLECTION, 0, p.amountMinor, "Cheque collection settled"),
    ],
    memo: "Cheque cleared",
    category: "SYSTEM",
  };
}

export function ruleChequeReturned(p: ChequeReturnedPayload): RuleResult {
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.amountMinor, 0, "AR reopened — cheque returned", { customerId: p.customerId }),
    line(SYSTEM_KEYS.BANK_ACCOUNT, 0, p.amountMinor, "Bank reversal", { customerId: p.customerId }),
  ];
  if (p.bankFeeMinor && p.bankFeeMinor > 0) {
    lines.push(line(SYSTEM_KEYS.COMMISSION_EXPENSE, p.bankFeeMinor, 0, "Bank return fee"));
    lines.push(line(SYSTEM_KEYS.BANK_ACCOUNT, 0, p.bankFeeMinor, "Bank fee paid"));
  }
  return { lines, memo: "Cheque returned", category: "SYSTEM" };
}

export function ruleCommissionAccrued(p: CommissionAccruedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.COMMISSION_EXPENSE, p.amountMinor, 0, "Commission earned", { salespersonId: p.salespersonId }),
      line(SYSTEM_KEYS.COMMISSION_PAYABLE, 0, p.amountMinor, "Commission payable", { salespersonId: p.salespersonId }),
    ],
    memo: "Commission accrued",
    category: "SYSTEM",
  };
}

export function ruleCommissionPaid(p: CommissionPaidPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.COMMISSION_PAYABLE, p.amountMinor, 0, "Commission settled", { salespersonId: p.salespersonId }),
      line(SYSTEM_KEYS.CASH_ON_HAND, 0, p.amountMinor, "Cash paid", { salespersonId: p.salespersonId }),
    ],
    memo: "Commission paid",
    category: "SYSTEM",
  };
}

export interface FinanceDisbursedPayload {
  applicationId: string;
  saleId: string;
  financeCompanyId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
}

export interface PaymentLinkReceivedPayload {
  intentId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  provider: string;
}

export function ruleFinanceDisbursed(p: FinanceDisbursedPayload): RuleResult {
  return {
    lines: [
      // Transfer the receivable from the customer to the finance company
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, p.amountMinor, 0, "Finance company receivable", { financeCompanyId: p.financeCompanyId, customerId: p.customerId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.amountMinor, "Customer AR offset by finance co", { customerId: p.customerId }),
    ],
    memo: "Finance company disbursement expected",
    category: "SYSTEM",
  };
}

export function rulePaymentLinkReceived(p: PaymentLinkReceivedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.BANK_ACCOUNT, p.amountMinor, 0, `Payment via ${p.provider}`, { customerId: p.customerId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.amountMinor, "AR settled via payment link", { customerId: p.customerId }),
    ],
    memo: `Payment link settled (${p.provider})`,
    category: "SYSTEM",
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export function applyPostingRule(eventType: string, payload: Record<string, unknown>): RuleResult {
  switch (eventType as EventType) {
    case "DEPOSIT_RECEIVED": return ruleDepositReceived(payload as unknown as DepositReceivedPayload);
    case "DEPOSIT_APPLIED": return ruleDepositApplied(payload as unknown as DepositAppliedPayload);
    case "DEPOSIT_REFUNDED": return ruleDepositRefunded(payload as unknown as DepositRefundedPayload);
    case "DEPOSIT_FORFEITED": return ruleDepositForfeited(payload as unknown as DepositForfeitedPayload);
    case "SALE_COMPLETED": return ruleSaleCompleted(payload as unknown as SaleCompletedPayload);
    case "COLLECTION_PAYMENT": return ruleCollectionPayment(payload as unknown as CollectionPaymentPayload);
    case "EXPENSE_POSTED": return ruleExpensePosted(payload as unknown as ExpensePostedPayload);
    case "CHEQUE_RECEIVED": return ruleChequeReceived(payload as unknown as ChequeReceivedPayload);
    case "CHEQUE_CLEARED": return ruleChequeClear(payload as unknown as ChequeClearedPayload);
    case "CHEQUE_RETURNED": return ruleChequeReturned(payload as unknown as ChequeReturnedPayload);
    case "COMMISSION_ACCRUED": return ruleCommissionAccrued(payload as unknown as CommissionAccruedPayload);
    case "COMMISSION_PAID": return ruleCommissionPaid(payload as unknown as CommissionPaidPayload);
    case "FINANCE_DISBURSED": return ruleFinanceDisbursed(payload as unknown as FinanceDisbursedPayload);
    case "PAYMENT_LINK_RECEIVED": return rulePaymentLinkReceived(payload as unknown as PaymentLinkReceivedPayload);
    default:
      throw new Error(`No posting rule defined for event type: ${eventType}`);
  }
}

export function validateBalance(lines: LineSpec[]): void {
  let totalDebits = 0;
  let totalCredits = 0;
  for (const l of lines) {
    if (l.debitMinor < 0 || l.creditMinor < 0) {
      throw new Error("Journal line amounts must be non-negative.");
    }
    if (l.debitMinor > 0 && l.creditMinor > 0) {
      throw new Error("A journal line cannot have both a debit and credit amount.");
    }
    if (l.debitMinor === 0 && l.creditMinor === 0) {
      throw new Error("A journal line must have either a debit or credit amount.");
    }
    totalDebits += l.debitMinor;
    totalCredits += l.creditMinor;
  }
  if (totalDebits !== totalCredits) {
    throw new Error(
      `Journal is not balanced: total debits ${totalDebits} ≠ total credits ${totalCredits}.`
    );
  }
}

export function simplePayloadHash(payload: Record<string, unknown>): string {
  const str = JSON.stringify(payload, Object.keys(payload).sort());
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
