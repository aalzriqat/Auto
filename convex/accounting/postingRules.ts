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
  | "COLLECTION_REFUND"
  | "EXPENSE_POSTED"
  | "CHEQUE_RECEIVED"
  | "CHEQUE_DEPOSITED"
  | "CHEQUE_CLEARED"
  | "CHEQUE_RETURNED"
  | "COMMISSION_ACCRUED"
  | "COMMISSION_PAID"
  | "FINANCE_DISBURSED"
  | "FINANCE_CASH_RECEIVED"
  | "PAYMENT_LINK_RECEIVED"
  | "SUPPLIER_PAYMENT_SETTLED"
  | "ASSET_CAPITALIZED"
  | "DEPRECIATION_POSTED"
  | "ASSET_IMPAIRED"
  | "ASSET_DISPOSED"
  | "CAPITAL_CONTRIBUTED"
  | "PARTNER_DREW"
  | "PROFIT_DISTRIBUTED"
  | "CLAIM_SETTLED"
  | "CLAIM_WRITTEN_OFF"
  | "CASH_DRAWER_DEPOSITED"
  | "VEHICLE_ACQUIRED"
  | "VEHICLE_LANDED_COST_CAPITALIZED"
  | "VEHICLE_INVENTORY_OPENING_BALANCE"
  | "VEHICLE_ACQUISITION_COST_CORRECTED"
  | "VEHICLE_PREP_EXPENSE_RECLASSIFIED"
  | "RECEIVABLE_CREATED"
  | "JOURNAL_REVERSAL";

export const ALL_EVENT_TYPES = new Set<string>([
  "DEPOSIT_RECEIVED", "DEPOSIT_APPLIED", "DEPOSIT_REFUNDED", "DEPOSIT_FORFEITED",
  "SALE_COMPLETED", "SALE_CANCELLED", "COLLECTION_PAYMENT", "COLLECTION_REFUND", "EXPENSE_POSTED",
  "CHEQUE_RECEIVED", "CHEQUE_DEPOSITED", "CHEQUE_CLEARED", "CHEQUE_RETURNED",
  "COMMISSION_ACCRUED", "COMMISSION_PAID",
  "FINANCE_DISBURSED", "FINANCE_CASH_RECEIVED", "PAYMENT_LINK_RECEIVED",
  "SUPPLIER_PAYMENT_SETTLED",
  "ASSET_CAPITALIZED", "DEPRECIATION_POSTED", "ASSET_IMPAIRED", "ASSET_DISPOSED",
  "CAPITAL_CONTRIBUTED", "PARTNER_DREW", "PROFIT_DISTRIBUTED",
  "CLAIM_SETTLED", "CLAIM_WRITTEN_OFF",
  "CASH_DRAWER_DEPOSITED",
  "VEHICLE_ACQUIRED", "VEHICLE_LANDED_COST_CAPITALIZED", "VEHICLE_INVENTORY_OPENING_BALANCE",
  "VEHICLE_ACQUISITION_COST_CORRECTED", "VEHICLE_PREP_EXPENSE_RECLASSIFIED", "RECEIVABLE_CREATED",
  // JOURNAL_REVERSAL is intentionally excluded: it is written directly by
  // reverseAccountingEvent() in reversals.ts and never goes through postAccountingEvent().
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
  // Card payments settle to the bank account (via payment gateway clearing).
  if (method === "CARD") return SYSTEM_KEYS.BANK_ACCOUNT;
  return opts?.defaultCash ?? SYSTEM_KEYS.CASH_ON_HAND;
}

// For outbound refund disbursements, CHEQUE means the dealership issues a
// cheque to the customer — crediting BANK_ACCOUNT (not CHEQUES_IN_HAND, which
// is for customer cheques physically held by the dealership).
function refundDisbursementAccountKey(method: string | undefined): SystemKey {
  if (method === "CHEQUE") return SYSTEM_KEYS.BANK_ACCOUNT;
  if (method === "BANK_TRANSFER") return SYSTEM_KEYS.BANK_ACCOUNT;
  if (method === "CARD") return SYSTEM_KEYS.BANK_ACCOUNT;
  return SYSTEM_KEYS.CASH_ON_HAND;
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
  /** When true the vehicle was sourced from another dealer; credits AP-Suppliers instead of Vehicle Inventory for COGS. */
  isSourced?: boolean;
}

export interface SupplierPaymentSettledPayload {
  payableId: string;
  sourcedFromName: string;
  amountMinor: number;
  /** Portion of amountMinor that is input VAT paid to the supplier (tax-inclusive, not additive). */
  taxMinor?: number;
  currency: string;
  paymentMethod?: string;
  /**
   * Which account AP-Suppliers was originally credited against for this
   * payable — a sourced/drop-ship vehicle credits AP against COST_OF_VEHICLES_SOLD
   * at sale time (ruleSaleCompleted), while an owned vehicle bought ON_ACCOUNT
   * credits it against VEHICLE_INVENTORY at acquisition time (ruleVehicleAcquired).
   * Defaults to "COGS" (the only case that existed before ON_ACCOUNT) so every
   * pre-existing caller keeps its current behavior unchanged.
   */
  costOrigin?: "COGS" | "VEHICLE_INVENTORY";
}

export interface CollectionPaymentPayload {
  paymentId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  paymentMethod?: string;
}

export interface CollectionRefundPayload {
  paymentId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  paymentMethod?: string;
}

export interface ExpensePostedPayload {
  expenseId: string;
  amountMinor: number;
  /** Portion of amountMinor that is input VAT paid (tax-inclusive, not additive). */
  taxMinor?: number;
  currency: string;
  paymentMethod?: string;
  category?: string;
  /** Present when this expense reconditions a specific in-stock vehicle. */
  vehicleId?: string;
  /** When true (vehicleId must also be set), the net amount capitalizes into Vehicle Inventory instead of hitting GENERAL_EXPENSE. */
  capitalizeToInventory?: boolean;
}

/**
 * Maps an operational expense category to a GL expense account system key.
 * Today every category routes to GENERAL_EXPENSE (the default chart has no
 * dedicated marketing/rent/salary accounts yet); the map exists so dedicated
 * accounts can be added later without touching the posting engine. Crucially,
 * general expenses are NO LONGER booked to COMMISSION_EXPENSE.
 */
export function expenseAccountKeyForCategory(_category?: string): SystemKey {
  return SYSTEM_KEYS.GENERAL_EXPENSE;
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
  paymentMethod?: string;
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
    // For sourced/drop-ship vehicles the dealer owes the supplier dealer — credit
    // AP-Suppliers instead of Vehicle Inventory (the car was never in stock).
    const costCreditKey = p.isSourced
      ? SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS
      : SYSTEM_KEYS.VEHICLE_INVENTORY;
    const costCreditDesc = p.isSourced ? "Supplier payable created" : "Inventory relief";
    lines.push(line(costCreditKey, 0, p.costMinor, costCreditDesc, { vehicleId: p.vehicleId }));
  }
  return { lines, memo: "Vehicle sale completed", category: "SYSTEM" };
}

export function ruleSupplierPaymentSettled(p: SupplierPaymentSettledPayload): RuleResult {
  const cashKey = p.paymentMethod === "CHEQUE"
    ? SYSTEM_KEYS.BANK_ACCOUNT
    : cashAccountKey(p.paymentMethod);
  // AP-Suppliers was originally credited for the full gross amountMinor back
  // at SALE_COMPLETED (ruleSaleCompleted's isSourced branch), so it must be
  // debited in full here too — netting it would leave a permanent residual
  // balance. If the actual supplier invoice reveals a VAT portion at
  // settlement time, reclassify it out of the previously-booked COGS into
  // VAT_RECEIVABLE as a separate, self-balancing pair rather than touching
  // the AP/cash settlement lines.
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, p.amountMinor, 0, `AP settled — ${p.sourcedFromName}`),
    line(cashKey, 0, p.amountMinor, "Cash paid to supplier"),
  ];
  if (p.taxMinor && p.taxMinor > 0) {
    // Reclassify out of whichever account AP was actually credited against
    // originally — crediting COST_OF_VEHICLES_SOLD for an ON_ACCOUNT owned
    // purchase would understate COGS for a vehicle that hasn't even sold yet.
    const costAccount = p.costOrigin === "VEHICLE_INVENTORY" ? SYSTEM_KEYS.VEHICLE_INVENTORY : SYSTEM_KEYS.COST_OF_VEHICLES_SOLD;
    lines.push(line(SYSTEM_KEYS.VAT_RECEIVABLE, p.taxMinor, 0, "Input VAT reclassified from cost"));
    lines.push(line(costAccount, 0, p.taxMinor, "Cost reduced by reclaimable VAT"));
  }
  return {
    lines,
    memo: `Supplier payment — ${p.sourcedFromName}`,
    category: "SYSTEM",
  };
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

export function ruleCollectionRefund(p: CollectionRefundPayload): RuleResult {
  // Mirror image of ruleCollectionPayment: cash goes back out and the
  // customer's receivable is reopened for the refunded amount.
  // Use the refund-specific mapper so outbound cheques credit BANK_ACCOUNT,
  // not CHEQUES_IN_HAND (which is reserved for cheques held from customers).
  const disbursementKey = refundDisbursementAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.amountMinor, 0, "AR reopened by refund", { customerId: p.customerId }),
      line(disbursementKey, 0, p.amountMinor, "Refund paid out", { customerId: p.customerId }),
    ],
    memo: "Collection payment refunded",
    category: "SYSTEM",
  };
}

export function ruleExpensePosted(p: ExpensePostedPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  const capitalize = p.capitalizeToInventory === true && !!p.vehicleId;
  const debitKey = capitalize ? SYSTEM_KEYS.VEHICLE_INVENTORY : expenseAccountKeyForCategory(p.category);
  const label = capitalize
    ? "Vehicle reconditioning cost capitalized"
    : p.category ? `Expense (${p.category})` : "General expense";
  // No prior liability exists for a plain expense (unlike the supplier-payable
  // settlement flow), so the net/tax split can happen directly here. A line
  // with a zero debit/credit is rejected by validateBalance, so only emit the
  // net-expense line when there's a non-zero net (i.e. not a 100%-VAT expense).
  const netMinor = p.taxMinor ? p.amountMinor - p.taxMinor : p.amountMinor;
  const lines: LineSpec[] = [];
  if (netMinor > 0) {
    lines.push(line(debitKey, netMinor, 0, label, capitalize ? { vehicleId: p.vehicleId } : undefined));
  }
  if (p.taxMinor && p.taxMinor > 0) {
    lines.push(line(SYSTEM_KEYS.VAT_RECEIVABLE, p.taxMinor, 0, "Input VAT paid"));
  }
  lines.push(line(cashKey, 0, p.amountMinor, "Cash payment"));
  return {
    lines,
    memo: capitalize ? "Vehicle reconditioning cost posted" : "Expense posted",
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
    lines.push(line(SYSTEM_KEYS.GENERAL_EXPENSE, p.bankFeeMinor, 0, "Bank return fee"));
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
  const cashKey = p.paymentMethod === "CHEQUE"
    ? SYSTEM_KEYS.BANK_ACCOUNT
    : cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.COMMISSION_PAYABLE, p.amountMinor, 0, "Commission settled", { salespersonId: p.salespersonId }),
      line(cashKey, 0, p.amountMinor, "Commission paid", { salespersonId: p.salespersonId }),
    ],
    memo: "Commission paid",
    category: "SYSTEM",
  };
}

export interface SaleCancelledPayload {
  saleId: string;
  saleAmountMinor: number;
  costMinor?: number;
  currency: string;
  customerId: string;
  vehicleId: string;
  salespersonId?: string;
  taxMinor?: number;
}

export interface ChequeDepositedPayload {
  chequeId: string;
  amountMinor: number;
  currency: string;
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

export interface FinanceCashReceivedPayload {
  applicationId: string;
  financeCompanyId: string;
  amountMinor: number;
  currency: string;
  customerId?: string;
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

export function ruleFinanceCashReceived(p: FinanceCashReceivedPayload): RuleResult {
  return {
    lines: [
      // Actual receipt of funds from the finance company settles their receivable
      line(SYSTEM_KEYS.BANK_ACCOUNT, p.amountMinor, 0, "Finance company disbursement received", { financeCompanyId: p.financeCompanyId }),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, 0, p.amountMinor, "Finance company receivable settled", { financeCompanyId: p.financeCompanyId, customerId: p.customerId }),
    ],
    memo: "Finance company disbursement received",
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

export function ruleSaleCancelled(p: SaleCancelledPayload): RuleResult {
  const revenueMinor = p.taxMinor ? p.saleAmountMinor - p.taxMinor : p.saleAmountMinor;
  const dims = { customerId: p.customerId, vehicleId: p.vehicleId, salespersonId: p.salespersonId };
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.SALES_REVENUE, revenueMinor, 0, "Revenue reversed", dims),
    line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.saleAmountMinor, "AR cancelled", dims),
  ];
  if (p.taxMinor && p.taxMinor > 0) {
    lines.push(line(SYSTEM_KEYS.SALES_TAX_PAYABLE, p.taxMinor, 0, "Sales tax reversed", { vehicleId: p.vehicleId }));
  }
  if (p.costMinor && p.costMinor > 0) {
    lines.push(line(SYSTEM_KEYS.VEHICLE_INVENTORY, p.costMinor, 0, "Inventory restored", { vehicleId: p.vehicleId }));
    lines.push(line(SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, 0, p.costMinor, "COGS reversed", { vehicleId: p.vehicleId }));
  }
  return { lines, memo: "Vehicle sale cancelled", category: "SYSTEM" };
}

export function ruleChequeDeposited(p: ChequeDepositedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CHEQUES_UNDER_COLLECTION, p.amountMinor, 0, "Cheque deposited for collection"),
      line(SYSTEM_KEYS.CHEQUES_IN_HAND, 0, p.amountMinor, "Cheque removed from hand"),
    ],
    memo: "Cheque deposited to bank",
    category: "SYSTEM",
  };
}

// ─── Vehicle inventory capitalization ─────────────────────────────────────────

export interface VehicleAcquiredPayload {
  vehicleId: string;
  costMinor: number;
  currency: string;
  paymentMethod?: string;
}

/**
 * Vehicle purchase: debit Vehicle Inventory, credit whatever paid for it. Only
 * ever fired for owned (non-sourced) stock. Outbound payment — same reasoning
 * as ruleAssetCapitalized/rulePartnerDrew: a cheque the dealership writes to
 * buy the vehicle clears from the bank, it doesn't sit in CHEQUES_IN_HAND
 * (which holds cheques received *from* customers).
 *
 * ON_ACCOUNT means no cash moved yet — the dealership owes the supplier for
 * an owned vehicle it already took into stock, so this credits AP-Suppliers
 * instead (the same account SOURCED vehicles use, just recorded at
 * acquisition time here rather than at sale time — see
 * vehicles.postVehicleAcquisitionIfOwned, which also creates the matching
 * vehicleSupplierPayables row). Settled later via sourcingPayables.markPaid,
 * same as a sourced-vehicle payable.
 */
export function ruleVehicleAcquired(p: VehicleAcquiredPayload): RuleResult {
  const isOnAccount = p.paymentMethod === "ON_ACCOUNT";
  const creditKey = isOnAccount
    ? SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS
    : p.paymentMethod === "CHEQUE" ? SYSTEM_KEYS.BANK_ACCOUNT : cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.VEHICLE_INVENTORY, p.costMinor, 0, "Vehicle acquired", { vehicleId: p.vehicleId }),
      line(creditKey, 0, p.costMinor, isOnAccount ? "Supplier payable created" : "Payment for vehicle", { vehicleId: p.vehicleId }),
    ],
    memo: "Vehicle acquired for inventory",
    category: "SYSTEM",
  };
}

export interface VehicleLandedCostCapitalizedPayload {
  vehicleId: string;
  currency: string;
  /**
   * Signed change per settlement account since the landed-cost record was
   * last saved (upsertLandedCosts replaces the whole items list on every
   * save, so the caller diffs old-vs-new items grouped by paymentMethod
   * rather than passing one aggregate delta) — a positive entry capitalizes
   * more cost into inventory paid from that account, a negative entry
   * reverses a previously capitalized amount from that SAME account (not
   * whatever account happens to be selected on this call).
   */
  accountDeltas: Array<{ paymentMethod?: string; deltaMinor: number }>;
}

/**
 * See VehicleLandedCostCapitalizedPayload — one Vehicle Inventory line for
 * the net change plus one cash/bank line per settlement account actually
 * affected, so a reduction reverses against the account it was originally
 * paid from even when other accounts were used for other items on the same
 * vehicle.
 */
export function ruleVehicleLandedCostCapitalized(p: VehicleLandedCostCapitalizedPayload): RuleResult {
  const lines: LineSpec[] = [];
  let netDeltaMinor = 0;
  for (const { paymentMethod, deltaMinor } of p.accountDeltas) {
    if (deltaMinor === 0) continue;
    // Outbound payment — see ruleVehicleAcquired for why CHEQUE routes to the bank.
    const cashKey = paymentMethod === "CHEQUE" ? SYSTEM_KEYS.BANK_ACCOUNT : cashAccountKey(paymentMethod);
    const amountMinor = Math.abs(deltaMinor);
    lines.push(
      deltaMinor > 0
        ? line(cashKey, 0, amountMinor, "Landed cost paid", { vehicleId: p.vehicleId })
        : line(cashKey, amountMinor, 0, "Landed cost reversed", { vehicleId: p.vehicleId })
    );
    netDeltaMinor += deltaMinor;
  }
  const netAmountMinor = Math.abs(netDeltaMinor);
  if (netDeltaMinor > 0) {
    lines.unshift(line(SYSTEM_KEYS.VEHICLE_INVENTORY, netAmountMinor, 0, "Landed cost capitalized", { vehicleId: p.vehicleId }));
  } else if (netDeltaMinor < 0) {
    lines.push(line(SYSTEM_KEYS.VEHICLE_INVENTORY, 0, netAmountMinor, "Landed cost correction", { vehicleId: p.vehicleId }));
  }
  return { lines, memo: "Vehicle landed cost adjusted", category: "SYSTEM" };
}

export interface VehicleInventoryOpeningBalancePayload {
  vehicleId: string;
  amountMinor: number;
  currency: string;
}

/**
 * One-time migration entry for vehicles that were already in stock when
 * inventory capitalization shipped (see accountingMigration.ts's
 * backfillVehicleInventoryOpeningBalances) — no cash actually moves today for
 * a purchase made in the past, so unlike VEHICLE_ACQUIRED this credits
 * Retained Earnings (a standard opening-balance adjustment) instead of
 * cash/bank, which would otherwise understate the current cash position.
 */
export function ruleVehicleInventoryOpeningBalance(p: VehicleInventoryOpeningBalancePayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.VEHICLE_INVENTORY, p.amountMinor, 0, "Opening inventory balance", { vehicleId: p.vehicleId }),
      line(SYSTEM_KEYS.RETAINED_EARNINGS, 0, p.amountMinor, "Opening balance adjustment", { vehicleId: p.vehicleId }),
    ],
    memo: "Vehicle inventory opening balance (migration backfill)",
    category: "ADJUSTMENT",
  };
}

export type AcquisitionCorrectionType =
  | "PRIOR_PERIOD_RESTATEMENT"
  | "SUPPLIER_INVOICE_ERROR"
  | "CASH_REFUND"
  | "VENDOR_CREDIT";

export interface VehicleAcquisitionCostCorrectedPayload {
  vehicleId: string;
  /** Signed change: new cost minus previous cost. */
  deltaMinor: number;
  currency: string;
  /** Drives the counter-account below — defaults to PRIOR_PERIOD_RESTATEMENT (the only behavior that existed before this field). */
  correctionType?: AcquisitionCorrectionType;
  /** Only meaningful (and required by the caller) when correctionType is CASH_REFUND. */
  paymentMethod?: string;
}

/**
 * Corrects a vehicle's acquisition cost after VEHICLE_ACQUIRED has already
 * posted (vehicles.correctAcquisitionCost) — e.g. the purchase price was
 * mis-entered. The counter-account depends on WHY the correction happened,
 * not just that it happened:
 *   - PRIOR_PERIOD_RESTATEMENT: no cash moves today for a correction to a
 *     genuinely past transaction — Retained Earnings, same reasoning as
 *     ruleVehicleInventoryOpeningBalance. The only behavior this rule had
 *     before correctionType existed, so it's also the default.
 *   - SUPPLIER_INVOICE_ERROR / VENDOR_CREDIT: the dealership still owes (or
 *     is owed) the supplier for the difference — routes through AP-Suppliers,
 *     the same account a credit-purchase or sourced vehicle uses, so it nets
 *     against whatever payable already exists there.
 *   - CASH_REFUND: real cash actually changed hands — routes to the
 *     caller-selected cash/bank account, same reasoning as ruleVehicleAcquired.
 * Also updates the vehicle's own purchasePrice (done by the caller), so
 * computeVehicleCapitalizedCost, commission, and reports stop reading the
 * stale figure instead of only the GL being corrected.
 */
export function ruleVehicleAcquisitionCostCorrected(p: VehicleAcquisitionCostCorrectedPayload): RuleResult {
  const amountMinor = Math.abs(p.deltaMinor);
  const counterKey = ((): SystemKey => {
    switch (p.correctionType) {
      case "SUPPLIER_INVOICE_ERROR":
      case "VENDOR_CREDIT":
        return SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS;
      case "CASH_REFUND":
        return p.paymentMethod === "CHEQUE" ? SYSTEM_KEYS.BANK_ACCOUNT : cashAccountKey(p.paymentMethod);
      case "PRIOR_PERIOD_RESTATEMENT":
      default:
        return SYSTEM_KEYS.RETAINED_EARNINGS;
    }
  })();
  const lines: LineSpec[] = p.deltaMinor > 0
    ? [
        line(SYSTEM_KEYS.VEHICLE_INVENTORY, amountMinor, 0, "Acquisition cost corrected upward", { vehicleId: p.vehicleId }),
        line(counterKey, 0, amountMinor, "Acquisition cost correction", { vehicleId: p.vehicleId }),
      ]
    : [
        line(counterKey, amountMinor, 0, "Acquisition cost correction", { vehicleId: p.vehicleId }),
        line(SYSTEM_KEYS.VEHICLE_INVENTORY, 0, amountMinor, "Acquisition cost corrected downward", { vehicleId: p.vehicleId }),
      ];
  return { lines, memo: "Vehicle acquisition cost corrected", category: "ADJUSTMENT" };
}

export interface VehiclePrepExpenseReclassifiedPayload {
  vehicleId: string;
  amountMinor: number;
  currency: string;
}

/**
 * Migration-only reclassification: a prep expense (repair/maintenance/etc.)
 * that was posted to GENERAL_EXPENSE before inventory capitalization shipped,
 * for a vehicle still in stock. Moves the net amount out of the P&L and into
 * Vehicle Inventory — unlike ruleVehicleInventoryOpeningBalance this credits
 * General Expense (reversing the original mis-posting), not Retained
 * Earnings, since the amount already has a real GL home to come out of. Only
 * safe to run for expenses in a still-open accounting period — see
 * accountingMigration.ts's backfillVehicleInventoryOpeningBalances.
 */
export function ruleVehiclePrepExpenseReclassified(p: VehiclePrepExpenseReclassifiedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.VEHICLE_INVENTORY, p.amountMinor, 0, "Prep expense reclassified to inventory", { vehicleId: p.vehicleId }),
      line(SYSTEM_KEYS.GENERAL_EXPENSE, 0, p.amountMinor, "Reclassified out of general expense", { vehicleId: p.vehicleId }),
    ],
    memo: "Vehicle prep expense reclassified (migration backfill)",
    category: "ADJUSTMENT",
  };
}

// ─── Manual receivables ────────────────────────────────────────────────────────

/** The finite set of credit-side accounts a manual receivable is allowed to originate against — see ruleReceivableCreated. */
export type ReceivableCreditKey = "MISCELLANEOUS_INCOME" | "CUSTOMER_DEPOSITS_LIABILITY" | "GENERAL_EXPENSE";

export interface ReceivableCreatedPayload {
  receivableId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  /**
   * Which account the receivable originates against — never silently assumed.
   * collections.ts derives CUSTOMER_DEPOSITS_LIABILITY automatically for the
   * two sourceTypes that are unambiguously "not yet earned" (CUSTOMER_DEPOSIT,
   * RESERVATION_PAYMENT); every other sourceType requires the caller to pick
   * one explicitly, since e.g. "internal installment" or "bank financed
   * balance" could equally be real income, a reimbursed cost, or a liability.
   */
  creditSystemKey: ReceivableCreditKey;
}

/**
 * Origin entry for a manually created receivable (collections.createReceivable /
 * createInstallmentPlan) that isn't tied to a vehicle sale — those already get
 * their AR from SALE_COMPLETED. The credit side is whatever the caller
 * determined this receivable actually represents (see creditSystemKey) —
 * never a blind default, since a receivable can just as easily be a customer
 * deposit liability or a cost reimbursement as genuine other income.
 */
export function ruleReceivableCreated(p: ReceivableCreatedPayload): RuleResult {
  const creditLabel =
    p.creditSystemKey === "CUSTOMER_DEPOSITS_LIABILITY"
      ? "Customer deposit liability"
      : p.creditSystemKey === "GENERAL_EXPENSE"
        ? "Cost reimbursement (reduces expense)"
        : "Other income";
  return {
    lines: [
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.amountMinor, 0, "Manual receivable created", { customerId: p.customerId }),
      line(SYSTEM_KEYS[p.creditSystemKey], 0, p.amountMinor, creditLabel, { customerId: p.customerId }),
    ],
    memo: "Manual receivable created",
    category: "SYSTEM",
  };
}

// ─── GL Phase 11: fixed-asset lifecycle ───────────────────────────────────────

export interface AssetCapitalizedPayload {
  assetId: string;
  costMinor: number;
  currency: string;
  paymentMethod?: string;
}

export interface DepreciationPostedPayload {
  assetId: string;
  amountMinor: number;
  currency: string;
}

export interface AssetImpairedPayload {
  assetId: string;
  amountMinor: number;
  currency: string;
}

export interface AssetDisposedPayload {
  assetId: string;
  costMinor: number;
  accumulatedDepreciationMinor: number;
  proceedsMinor: number;
  currency: string;
}

export function ruleAssetCapitalized(p: AssetCapitalizedPayload): RuleResult {
  // Outbound payment: cashAccountKey's CHEQUE branch maps to CHEQUES_IN_HAND,
  // which holds customer cheques we've *received* — wrong side for paying a
  // supplier by our own cheque, which ultimately clears from our bank.
  const cashKey = p.paymentMethod === "CHEQUE"
    ? SYSTEM_KEYS.BANK_ACCOUNT
    : cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.FIXED_ASSETS, p.costMinor, 0, "Asset capitalized"),
      line(cashKey, 0, p.costMinor, "Payment for asset"),
    ],
    memo: "Fixed asset capitalized",
    category: "SYSTEM",
  };
}

export function ruleDepreciationPosted(p: DepreciationPostedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.DEPRECIATION_EXPENSE, p.amountMinor, 0, "Depreciation expense"),
      line(SYSTEM_KEYS.ACCUMULATED_DEPRECIATION, 0, p.amountMinor, "Accumulated depreciation"),
    ],
    memo: "Monthly depreciation posted",
    category: "SYSTEM",
  };
}

export function ruleAssetImpaired(p: AssetImpairedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.IMPAIRMENT_LOSS, p.amountMinor, 0, "Impairment loss"),
      line(SYSTEM_KEYS.ACCUMULATED_DEPRECIATION, 0, p.amountMinor, "Impairment recorded as additional accumulated depreciation"),
    ],
    memo: "Fixed asset impaired",
    category: "SYSTEM",
  };
}

/**
 * Derecognizes the asset's full cost and its accumulated depreciation, records
 * any cash proceeds, and books the balancing gain or loss (proceeds vs. net
 * book value). Zero-amount lines are omitted since a manual/system journal
 * line can't have both a zero debit and a zero credit (validateBalance would
 * reject it) — omitting a genuinely-zero line never affects balance, since a
 * zero contribution can't unbalance the entry either way.
 */
export function ruleAssetDisposed(p: AssetDisposedPayload): RuleResult {
  const netBookValue = p.costMinor - p.accumulatedDepreciationMinor;
  const gainOrLoss = p.proceedsMinor - netBookValue;

  const lines: LineSpec[] = [];
  if (p.accumulatedDepreciationMinor > 0) {
    lines.push(line(SYSTEM_KEYS.ACCUMULATED_DEPRECIATION, p.accumulatedDepreciationMinor, 0, "Remove accumulated depreciation"));
  }
  if (p.proceedsMinor > 0) {
    lines.push(line(SYSTEM_KEYS.BANK_ACCOUNT, p.proceedsMinor, 0, "Disposal proceeds"));
  }
  lines.push(line(SYSTEM_KEYS.FIXED_ASSETS, 0, p.costMinor, "Remove asset cost"));
  if (gainOrLoss > 0) {
    lines.push(line(SYSTEM_KEYS.GAIN_ON_DISPOSAL, 0, gainOrLoss, "Gain on disposal"));
  } else if (gainOrLoss < 0) {
    lines.push(line(SYSTEM_KEYS.LOSS_ON_DISPOSAL, -gainOrLoss, 0, "Loss on disposal"));
  }

  return { lines, memo: "Fixed asset disposed", category: "SYSTEM" };
}

// ─── GL Phase 12: partner equity movements ────────────────────────────────────

/**
 * partnerId is optional metadata: journal lines carry no partner dimension,
 * and Phase 6 legacy-transaction migration posts these events for old
 * PARTNER_DRAW/CAPITAL_INJECTION rows that never recorded which partner.
 */
export interface PartnerEquityMovementPayload {
  partnerId?: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
}

export function ruleCapitalContributed(p: PartnerEquityMovementPayload): RuleResult {
  // Inbound money: a cheque handed over by the partner genuinely sits in
  // CHEQUES_IN_HAND, so the shared inbound mapper applies as-is.
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, "Capital contribution received"),
      line(SYSTEM_KEYS.PARTNER_CAPITAL, 0, p.amountMinor, "Partner capital"),
    ],
    memo: "Partner capital contributed",
    category: "SYSTEM",
  };
}

export function rulePartnerDrew(p: PartnerEquityMovementPayload): RuleResult {
  // Outbound payment — same reasoning as refundDisbursementAccountKey and
  // ruleAssetCapitalized: our own cheque clears from the bank.
  const cashKey = p.paymentMethod === "CHEQUE"
    ? SYSTEM_KEYS.BANK_ACCOUNT
    : cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.PARTNER_DRAWINGS, p.amountMinor, 0, "Partner draw"),
      line(cashKey, 0, p.amountMinor, "Draw paid out"),
    ],
    memo: "Partner draw",
    category: "SYSTEM",
  };
}

export function ruleProfitDistributed(p: PartnerEquityMovementPayload): RuleResult {
  // Pure equity reclassification — accumulated profit becomes partner
  // capital; no cash moves until the partner later draws it.
  return {
    lines: [
      line(SYSTEM_KEYS.RETAINED_EARNINGS, p.amountMinor, 0, "Profit distributed to partner"),
      line(SYSTEM_KEYS.PARTNER_CAPITAL, 0, p.amountMinor, "Partner capital increased"),
    ],
    memo: "Profit distributed to partner capital",
    category: "SYSTEM",
  };
}

// ─── GL Phase 13: claim receivables ───────────────────────────────────────────

export interface ClaimSettledPayload {
  claimId: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
}

export interface ClaimWrittenOffPayload {
  claimId: string;
  amountMinor: number;
  currency: string;
}

export function ruleClaimSettled(p: ClaimSettledPayload): RuleResult {
  // Finance companies settle by transfer unless told otherwise, so the
  // no-method default is the bank, not the cash drawer. An explicit CASH
  // still hits the drawer (cashAccountKey's defaultCash option can't express
  // that — it also swallows explicit CASH, which falls through to the
  // default), and an inbound cheque genuinely lands in CHEQUES_IN_HAND.
  const cashKey = p.paymentMethod === undefined
    ? SYSTEM_KEYS.BANK_ACCOUNT
    : cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, "Claim settlement received"),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, 0, p.amountMinor, "Finance-company AR settled"),
    ],
    memo: "Finance-company claim settled",
    category: "SYSTEM",
  };
}

export function ruleClaimWrittenOff(p: ClaimWrittenOffPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.CLAIM_WRITE_OFF_EXPENSE, p.amountMinor, 0, "Rejected claim written off"),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, 0, p.amountMinor, "Finance-company AR written off"),
    ],
    memo: "Rejected claim written off",
    category: "SYSTEM",
  };
}

// ─── GL Phase 15: cash-drawer bank deposit ────────────────────────────────────

export interface CashDrawerDepositedPayload {
  sessionId: string;
  amountMinor: number;
  currency: string;
}

export function ruleCashDrawerDeposited(p: CashDrawerDepositedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.BANK_ACCOUNT, p.amountMinor, 0, "Cash drawer deposited to bank"),
      line(SYSTEM_KEYS.CASH_ON_HAND, 0, p.amountMinor, "Drawer cash removed"),
    ],
    memo: "Cash drawer session deposited",
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
    case "SALE_CANCELLED": return ruleSaleCancelled(payload as unknown as SaleCancelledPayload);
    case "CHEQUE_DEPOSITED": return ruleChequeDeposited(payload as unknown as ChequeDepositedPayload);
    case "COLLECTION_PAYMENT": return ruleCollectionPayment(payload as unknown as CollectionPaymentPayload);
    case "COLLECTION_REFUND": return ruleCollectionRefund(payload as unknown as CollectionRefundPayload);
    case "EXPENSE_POSTED": return ruleExpensePosted(payload as unknown as ExpensePostedPayload);
    case "CHEQUE_RECEIVED": return ruleChequeReceived(payload as unknown as ChequeReceivedPayload);
    case "CHEQUE_CLEARED": return ruleChequeClear(payload as unknown as ChequeClearedPayload);
    case "CHEQUE_RETURNED": return ruleChequeReturned(payload as unknown as ChequeReturnedPayload);
    case "COMMISSION_ACCRUED": return ruleCommissionAccrued(payload as unknown as CommissionAccruedPayload);
    case "COMMISSION_PAID": return ruleCommissionPaid(payload as unknown as CommissionPaidPayload);
    case "FINANCE_DISBURSED": return ruleFinanceDisbursed(payload as unknown as FinanceDisbursedPayload);
    case "FINANCE_CASH_RECEIVED": return ruleFinanceCashReceived(payload as unknown as FinanceCashReceivedPayload);
    case "PAYMENT_LINK_RECEIVED": return rulePaymentLinkReceived(payload as unknown as PaymentLinkReceivedPayload);
    case "SUPPLIER_PAYMENT_SETTLED": return ruleSupplierPaymentSettled(payload as unknown as SupplierPaymentSettledPayload);
    case "ASSET_CAPITALIZED": return ruleAssetCapitalized(payload as unknown as AssetCapitalizedPayload);
    case "DEPRECIATION_POSTED": return ruleDepreciationPosted(payload as unknown as DepreciationPostedPayload);
    case "ASSET_IMPAIRED": return ruleAssetImpaired(payload as unknown as AssetImpairedPayload);
    case "ASSET_DISPOSED": return ruleAssetDisposed(payload as unknown as AssetDisposedPayload);
    case "CAPITAL_CONTRIBUTED": return ruleCapitalContributed(payload as unknown as PartnerEquityMovementPayload);
    case "PARTNER_DREW": return rulePartnerDrew(payload as unknown as PartnerEquityMovementPayload);
    case "PROFIT_DISTRIBUTED": return ruleProfitDistributed(payload as unknown as PartnerEquityMovementPayload);
    case "CLAIM_SETTLED": return ruleClaimSettled(payload as unknown as ClaimSettledPayload);
    case "CLAIM_WRITTEN_OFF": return ruleClaimWrittenOff(payload as unknown as ClaimWrittenOffPayload);
    case "CASH_DRAWER_DEPOSITED": return ruleCashDrawerDeposited(payload as unknown as CashDrawerDepositedPayload);
    case "VEHICLE_ACQUIRED": return ruleVehicleAcquired(payload as unknown as VehicleAcquiredPayload);
    case "VEHICLE_LANDED_COST_CAPITALIZED": return ruleVehicleLandedCostCapitalized(payload as unknown as VehicleLandedCostCapitalizedPayload);
    case "VEHICLE_INVENTORY_OPENING_BALANCE": return ruleVehicleInventoryOpeningBalance(payload as unknown as VehicleInventoryOpeningBalancePayload);
    case "VEHICLE_ACQUISITION_COST_CORRECTED": return ruleVehicleAcquisitionCostCorrected(payload as unknown as VehicleAcquisitionCostCorrectedPayload);
    case "VEHICLE_PREP_EXPENSE_RECLASSIFIED": return ruleVehiclePrepExpenseReclassified(payload as unknown as VehiclePrepExpenseReclassifiedPayload);
    case "RECEIVABLE_CREATED": return ruleReceivableCreated(payload as unknown as ReceivableCreatedPayload);
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

/** Recursively sorts object keys so the JSON serialization is canonical. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort((a, b) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

export async function simplePayloadHash(payload: Record<string, unknown>): Promise<string> {
  // NOTE: the previous implementation passed the sorted key array as the second
  // JSON.stringify argument, which is a property *allowlist*, not a sort — nested
  // objects and arrays were silently dropped from the digest. Canonicalize first.
  const str = JSON.stringify(canonicalize(payload));
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
