import { ConvexError } from "convex/values";
import { SYSTEM_KEYS, SystemKey } from "../utils/defaultChart";
import { scaleForCurrency } from "../utils/money";

export type EventType =
  | "DEPOSIT_RECEIVED"
  | "DEPOSIT_APPLIED"
  | "DEPOSIT_APPLIED_TO_SETTLEMENT"
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
  | "COMMISSION_ADJUSTED"
  | "COMMISSION_PAID"
  | "FINANCE_DISBURSED"
  | "FINANCE_CASH_RECEIVED"
  | "PAYMENT_LINK_RECEIVED"
  | "SUPPLIER_PAYMENT_SETTLED"
  | "SUPPLIER_RECEIVABLE_COLLECTED"
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
  | "TRADE_IN_ACCEPTED"
  | "FI_COMMISSION_RECOGNIZED"
  | "PREPAID_EXPENSE_AMORTIZED"
  | "PREPAID_EXPENSE_REFUNDED"
  | "PREPAID_EXPENSE_WRITTEN_OFF"
  | "RECEIVABLE_CREATED"
  | "CONSIGNED_SALE_RECLASSIFIED"
  | "EMPLOYEE_ADVANCE_PAID"
  | "EMPLOYEE_ADVANCE_RECOVERED"
  | "PAYROLL_ACCRUED"
  | "PAYROLL_PAID"
  | "JOURNAL_REVERSAL";

export const ALL_EVENT_TYPES = new Set<string>([
  "DEPOSIT_RECEIVED", "DEPOSIT_APPLIED", "DEPOSIT_APPLIED_TO_SETTLEMENT",
  "DEPOSIT_REFUNDED", "DEPOSIT_FORFEITED",
  "SALE_COMPLETED", "SALE_CANCELLED", "COLLECTION_PAYMENT", "COLLECTION_REFUND", "EXPENSE_POSTED",
  "CHEQUE_RECEIVED", "CHEQUE_DEPOSITED", "CHEQUE_CLEARED", "CHEQUE_RETURNED",
  "COMMISSION_ACCRUED", "COMMISSION_ADJUSTED", "COMMISSION_PAID",
  "FINANCE_DISBURSED", "FINANCE_CASH_RECEIVED", "PAYMENT_LINK_RECEIVED",
  "SUPPLIER_PAYMENT_SETTLED", "SUPPLIER_RECEIVABLE_COLLECTED",
  "ASSET_CAPITALIZED", "DEPRECIATION_POSTED", "ASSET_IMPAIRED", "ASSET_DISPOSED",
  "CAPITAL_CONTRIBUTED", "PARTNER_DREW", "PROFIT_DISTRIBUTED",
  "CLAIM_SETTLED", "CLAIM_WRITTEN_OFF",
  "CASH_DRAWER_DEPOSITED",
  "VEHICLE_ACQUIRED", "VEHICLE_LANDED_COST_CAPITALIZED", "VEHICLE_INVENTORY_OPENING_BALANCE",
  "VEHICLE_ACQUISITION_COST_CORRECTED", "VEHICLE_PREP_EXPENSE_RECLASSIFIED", "TRADE_IN_ACCEPTED",
  "FI_COMMISSION_RECOGNIZED",
  "PREPAID_EXPENSE_AMORTIZED",
  "PREPAID_EXPENSE_REFUNDED",
  "PREPAID_EXPENSE_WRITTEN_OFF",
  "RECEIVABLE_CREATED",
  "CONSIGNED_SALE_RECLASSIFIED",
  "EMPLOYEE_ADVANCE_PAID", "EMPLOYEE_ADVANCE_RECOVERED", "PAYROLL_ACCRUED", "PAYROLL_PAID",
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
  /**
   * The event really happened and really has no accounting consequence.
   *
   * Distinct from an empty `lines` array reached by accident: `validateBalance`
   * waves zero lines through because 0 === 0, so a rule that returned nothing
   * silently posted a journal entry with no lines — a row asserting an event
   * the books do not reflect, counted by every reconciliation and entry total.
   * Saying so explicitly means the engine can skip the entry instead of writing
   * an empty one, and a rule that returns nothing by mistake still fails.
   */
  skipPosting?: boolean;
}

function cashAccountKey(
  method: string | undefined,
  opts?: { defaultCash?: SystemKey }
): SystemKey {
  if (method === "CHEQUE") return SYSTEM_KEYS.CHEQUES_IN_HAND;
  if (method === "BANK_TRANSFER") return SYSTEM_KEYS.BANK_ACCOUNT;
  // Card payments settle to the bank account (via payment gateway clearing).
  if (method === "CARD") return SYSTEM_KEYS.BANK_ACCOUNT;
  // Payment links settle to the bank account too, same as PAYMENT_LINK_RECEIVED's
  // dedicated automatic flow in rulePaymentLinkReceived — this just makes the
  // generic manual-entry paymentMethod field consistent with that.
  if (method === "PAYMENT_LINK") return SYSTEM_KEYS.BANK_ACCOUNT;
  return opts?.defaultCash ?? SYSTEM_KEYS.CASH_ON_HAND;
}

// For ANY outbound disbursement (refunds, payroll, employee advances), CHEQUE
// means the dealership ISSUES a cheque — crediting BANK_ACCOUNT (not
// CHEQUES_IN_HAND, which is strictly an asset of customer cheques physically
// held by the dealership). cashAccountKey is the inbound mapper.
function disbursementAccountKey(method: string | undefined): SystemKey {
  if (method === "CHEQUE") return SYSTEM_KEYS.BANK_ACCOUNT;
  if (method === "BANK_TRANSFER") return SYSTEM_KEYS.BANK_ACCOUNT;
  if (method === "CARD") return SYSTEM_KEYS.BANK_ACCOUNT;
  if (method === "PAYMENT_LINK") return SYSTEM_KEYS.BANK_ACCOUNT;
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
  paymentMethod?: string;
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
  /**
   * Set by every emitter that knows consigned-agent basis exists — i.e. every
   * one of them from this deploy onward. It is how this rule tells a caller
   * that FORGOT the consignment details from one that predates them.
   *
   * It matters because outbox entries outlive deploys. An organization that
   * enabled accounting after selling sourced cars has SALE_COMPLETED events
   * queued from before agent basis existed: no `consignment`, and no way to
   * reconstruct one, since the settlement route was never asked for and the
   * supplier's entitlement was recorded only as a cost. Failing those closed
   * would dead-letter them after MAX_ATTEMPTS and drop the sale off the books
   * entirely; inventing a consignment block would be worse — it would fabricate
   * a settlement route nobody chose.
   *
   * So a legacy event posts on the basis it was written for, exactly as it
   * would have before this change, and the restatement to agent basis is left
   * to `migrateConsignedSaleBasis`, which is the same treatment every already-
   * posted historical sourced sale gets. Absence never grants permission to a
   * NEW event: those all carry the flag, so a missing consignment there is a
   * bug and still throws.
   */
  consignmentEvaluated?: boolean;
  /**
   * Present when the vehicle is legally the supplier's and the dealership sold
   * it as his agent. Its presence switches this rule to agent basis entirely:
   * commission on the spread, no vehicle revenue, no COGS, no inventory.
   *
   * `settlementRoute` says where the buyer's money went. DIRECT_TO_SUPPLIER
   * means the dealership never touched it and simply holds a claim for its
   * margin. THROUGH_DEALERSHIP means gross landed in the dealership's account
   * on the supplier's behalf, so the supplier's share is a liability from the
   * moment it arrives — never revenue in transit.
   */
  consignment?: {
    supplierEntitlementMinor: number;
    /**
     * What the third party actually pays the supplier on the DIRECT route — the
     * basis the dealership's commission is measured against.
     *
     * Absent means "the sale price", which is what a cash direct sale and every
     * event queued before this field existed both mean. A FINANCED direct deal
     * sets it to the finance company's approved purchase amount, because that
     * is the money that reaches him; measuring the commission against the sale
     * price there credited revenue on a spread no party ever paid, and debited
     * a supplier receivable to match.
     *
     * Unused on THROUGH_DEALERSHIP, where the dealership collects the gross and
     * the customer is liable for the full sale price.
     */
    supplierGrossReceiptMinor?: number;
    /**
     * Whether an outside financier pays for this car, carried so the rule can
     * tell a legacy CASH direct event from a financed one.
     *
     * Without it the fallback below is indistinguishable from a guess: a queued
     * event with no `supplierGrossReceiptMinor` could be a pre-field cash sale
     * (where the sale price IS what the supplier received) or a pre-field
     * financed one (where it is not). Draining the second as though it were the
     * first posts the very receivable this redesign removes.
     */
    externallyFinanced?: boolean;
    supplierName?: string;
    settlementRoute: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP";
  };
  /** Documentation/admin fees charged on top of the vehicle price — added to the AR debit, credited to Dealer Fee Income. */
  dealerFeesMinor?: number;
  /**
   * Warranty/GAP premium collected from the customer (added to the AR debit)
   * and the portion of it owed to the third-party underwriter (credited to
   * Warranty & GAP Payable) — the dealer resells these, it doesn't underwrite
   * them. The remainder (sold − cost) is the dealer's own margin, credited to
   * Deferred F&I Commission rather than recognized immediately; see
   * dealerProductDeferrals and recognizeDeferredCommissionForMonth for how it
   * later moves to FI_COMMISSION_REVENUE.
   */
  warrantySoldMinor?: number;
  warrantyCostMinor?: number;
  gapSoldMinor?: number;
  gapCostMinor?: number;
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
  /**
   * When true, the net amount is a balance-sheet asset (Prepaid Expenses),
   * released to the expense account ratably over its term — not an immediate
   * expense. Takes precedence over category routing but NOT over inventory
   * capitalization (a vehicle recon cost is never "prepaid"; the two are
   * mutually exclusive and prepaid only ever applies to non-vehicle expenses).
   */
  isPrepaid?: boolean;
}

/**
 * Maps an operational expense category to a GL expense account system key,
 * so an accountant gets a real operating-expense breakdown instead of every
 * category landing in one undifferentiated GENERAL_EXPENSE bucket. Crucially,
 * general expenses are NO LONGER booked to COMMISSION_EXPENSE.
 *
 * REPAIR/MAINTENANCE/DETAILING/TRANSPORT are deliberately excluded here: when
 * vehicle-linked and not yet sold, those capitalize into Vehicle Inventory
 * instead (see the capitalize branch in ruleExpensePosted below) — they only
 * fall through to this mapper when NOT vehicle-linked (e.g. office/shop
 * repairs), where GENERAL_EXPENSE remains the right catch-all, same as OTHER.
 * PREPAID is also excluded: a prepaid expense is a balance-sheet asset until
 * amortized, not an immediate expense — mapping it into an expense account
 * here would be a new wrong-account bug, not a fix. It stays GENERAL_EXPENSE
 * until prepaid-expense GL wiring is built as its own piece of work.
 */
export function expenseAccountKeyForCategory(category?: string): SystemKey {
  switch (category) {
    case "RENT": return SYSTEM_KEYS.RENT_EXPENSE;
    case "UTILITIES": return SYSTEM_KEYS.UTILITIES_EXPENSE;
    case "SALARIES": return SYSTEM_KEYS.SALARIES_EXPENSE;
    case "MARKETING": return SYSTEM_KEYS.MARKETING_EXPENSE;
    case "OFFICE": return SYSTEM_KEYS.OFFICE_EXPENSE;
    case "FEES": return SYSTEM_KEYS.PROFESSIONAL_FEES_EXPENSE;
    default: return SYSTEM_KEYS.GENERAL_EXPENSE;
  }
}

export interface CommissionAccruedPayload {
  saleId: string;
  amountMinor: number;
  currency: string;
  salespersonId: string;
}

/**
 * A correction to an already-recognized commission. `deltaMinor` is SIGNED —
 * the difference between the new amount and the one currently on the books, not
 * the new amount itself. Posting the new amount instead would double the
 * liability, so the sign is the whole point of the payload.
 */
export interface CommissionAdjustedPayload {
  saleId: string;
  deltaMinor: number;
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

export interface DepositAppliedToSettlementPayload {
  depositId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  supplierName?: string;
  saleId?: string;
}

/**
 * A reservation deposit the dealership keeps as part of settling a consigned
 * deal with the supplier.
 *
 * Only reachable on the DIRECT_TO_SUPPLIER route. There the buyer paid the
 * supplier for the car, so the dealership holds no receivable from the customer
 * for it — but it IS holding the customer's deposit in cash, against the margin
 * the supplier now owes it. Releasing the deposit liability against that claim
 * turns cash already in hand into margin realized.
 *
 * It credits the supplier receivable rather than commission revenue, even
 * though this is the point at which the deposit "becomes part of the
 * dealership's earned margin". Agent-basis revenue is recognized in full when
 * the sale completes; crediting it again here would count the same margin
 * twice, once as revenue earned and once as revenue collected. The economics
 * the dealer described are unchanged either way — what differs is only whether
 * the books say it twice.
 *
 * On THROUGH_DEALERSHIP this treatment is refused upstream: the supplier's
 * entitlement is already credited to AP-Suppliers in full at sale, so crediting
 * it again would inflate what the dealership owes him by the deposit.
 */
export function ruleDepositAppliedToSettlement(p: DepositAppliedToSettlementPayload): RuleResult {
  const supplier = p.supplierName ?? "supplier";
  return {
    lines: [
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, p.amountMinor, 0, "Reservation deposit released", { customerId: p.customerId }),
      line(SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, 0, p.amountMinor, `Deposit retained against commission due from ${supplier}`, { customerId: p.customerId }),
    ],
    memo: "Reservation deposit applied to supplier settlement",
    category: "SYSTEM",
  };
}

export function ruleDepositRefunded(p: DepositRefundedPayload): RuleResult {
  const disbursementKey = disbursementAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, p.amountMinor, 0, "Deposit liability released", { customerId: p.customerId }),
      line(disbursementKey, 0, p.amountMinor, "Deposit refund paid out", { customerId: p.customerId }),
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

/**
 * The dealer resells a warranty/GAP product for `soldMinor`, owing
 * `costMinor` of it to the third-party underwriter; the rest is the dealer's
 * own margin. Cost is clamped to the sold amount so a data-entry mistake
 * (cost > sold) can never produce a negative margin. Shared by
 * ruleSaleCompleted (GL posting, below) and saleCompletion.ts's deferral-row
 * creation — both need the identical clamp/margin math, or the GL-posted
 * margin and the margin tracked for deferred recognition can silently
 * diverge if only one side of a future edit gets updated.
 */
export function computeResoldProductMargin(
  soldMinor: number,
  costMinor: number
): { clampedCostMinor: number; marginMinor: number } {
  const clampedCostMinor = Math.min(Math.max(costMinor, 0), soldMinor);
  return { clampedCostMinor, marginMinor: soldMinor - clampedCostMinor };
}

/**
 * Adds a resold warranty/GAP product's lines: the full premium collected
 * from the customer was already folded into the AR debit by the caller; this
 * only adds the credit side — cost owed to the underwriter (if any) and the
 * dealer's own margin, deferred rather than recognized immediately.
 */
function addResoldProductLines(
  lines: LineSpec[],
  soldMinor: number,
  costMinor: number,
  label: string,
  dims: { customerId?: string; vehicleId?: string; salespersonId?: string }
): void {
  const { clampedCostMinor, marginMinor } = computeResoldProductMargin(soldMinor, costMinor);
  if (clampedCostMinor > 0) {
    lines.push(line(SYSTEM_KEYS.WARRANTY_GAP_PAYABLE, 0, clampedCostMinor, `${label} premium payable`, dims));
  }
  if (marginMinor > 0) {
    lines.push(line(SYSTEM_KEYS.DEFERRED_FI_COMMISSION, 0, marginMinor, `${label} deferred commission`, dims));
  }
}

/**
 * A consigned vehicle sold as the supplier's agent.
 *
 * The dealership never owned the car, never invoiced the buyer for it, and may
 * recognize only the spread over the supplier's entitlement. Booking the gross
 * as revenue with the entitlement as COGS reaches the same bottom line — which
 * is exactly why it survived so long — but it inflates turnover, cost of sales,
 * receivables and payables by the supplier's share, and puts a car the
 * dealership never owned through its inventory.
 */
function consignedAgentSaleLines(p: SaleCompletedPayload): RuleResult {
  const consignment = p.consignment!;
  const entitlementMinor = consignment.supplierEntitlementMinor;
  // The dealership's commission is its spread over the supplier's entitlement —
  // but over WHICH amount depends on who paid him, and the two are not the same
  // number on a financed direct deal.
  //
  // DIRECT: the basis is what actually reaches the supplier. `saleAmountMinor`
  // would include `salePrice − approved`, an amount no party pays him, and
  // crediting commission revenue for it also debits AR-Suppliers for it — the
  // GL asserting a collectable debt against somebody who never received the
  // money. Absent, it falls back to the sale price, which is exactly right for
  // a cash direct sale (the buyer pays him the price) and for any event queued
  // before this field existed.
  //
  // THROUGH: the dealership collects the gross and the customer is liable for
  // the whole sale price, so the spread genuinely is over `saleAmountMinor`.
  // Unchanged, deliberately — this rule was never wrong on that route.
  // A financed direct event with no recorded receipt is refused, not guessed.
  //
  // The fallback is correct for a CASH direct sale and for every event queued
  // before the field existed — `main` refuses financed + DIRECT in
  // `completeSale`, so no such event can be sitting in a production outbox. It
  // is NOT correct for a financed one, and an event queued by an unreleased
  // build could be. Draining it against the sale price would post exactly the
  // receivable this redesign removes, silently, out of sight of whoever sold
  // the car — and an outbox drains long after anyone is watching.
  //
  // Dead-lettering it is the right failure: the entry is repaired and re-posted
  // deliberately, rather than the ledger quietly acquiring a debt against a
  // supplier who never received the money.
  const dims = { customerId: p.customerId, vehicleId: p.vehicleId, salespersonId: p.salespersonId };
  const supplier = consignment.supplierName ?? "supplier";

  // Scoped to events that explicitly say they are financed, which only the
  // current emitter sets. An event queued by an older build carries no marker
  // and falls through to the sale price — and that is correct for it, because
  // the claim that build opened was raised on the same basis, so the ledger and
  // the subledger stay consistent with each other. Repairing those rows is a
  // data question, not a posting-rule question, and dead-lettering them here
  // would strand entries that currently reconcile.
  if (
    consignment.settlementRoute === "DIRECT_TO_SUPPLIER" &&
    consignment.supplierGrossReceiptMinor === undefined &&
    consignment.externallyFinanced === true
  ) {
    throw new Error(
      `Consigned sale ${p.saleId} settles directly with ${supplier} and is externally financed, but records no amount actually paid to him. The dealership's claim cannot be measured against the sale price on this route — repair the event with the finance company's approved amount before posting it.`
    );
  }
  const settlementBasisMinor =
    consignment.settlementRoute === "DIRECT_TO_SUPPLIER"
      ? (consignment.supplierGrossReceiptMinor ?? p.saleAmountMinor)
      : p.saleAmountMinor;
  const marginMinor = settlementBasisMinor - entitlementMinor;

  // Fail closed. A negative margin means the supplier is paid less than he is
  // owed, which is a real situation but not one this rule may guess at —
  // posting a negative commission would misstate revenue and hide a loss the
  // dealership has to fund. It needs a decision, not a default.
  if (marginMinor < 0) {
    throw new Error(
      `Consigned sale ${p.saleId} settles ${Math.abs(marginMinor)} minor units below the supplier's entitlement of ${entitlementMinor}. Record the shortfall against the supplier agreement before completing the sale.`
    );
  }

  // Sales tax on an agency sale: refused, not guessed.
  //
  // Ignoring `taxMinor` — as this rule did — meant a consigned sale with tax
  // credited the WHOLE margin to commission revenue and recorded no liability,
  // so the dealership held the customer's tax money with nothing on the books
  // saying it owed it. The entry balanced throughout, which is why nothing
  // caught it. That silent drop is what this refusal closes.
  //
  // It is a refusal rather than a posting because the codebase holds TWO
  // contradictory tax conventions, and every way of posting tax here either
  // misstates money or invents policy. Settled deliberately, with the evidence:
  //
  // What the amount actually is: `saleAmountMinor` is tax-EXCLUSIVE.
  // `saleCompletion` passes `args.salePrice` straight through, and `SaleDialog`
  // bills the customer `salePrice + taxAmount + fees + …`. So the tax is added
  // on top of the price, not contained in it.
  //
  // What the principal rule does with it: treats it as INCLUSIVE — revenue is
  // `saleAmount - tax` and the AR debit omits the tax, so the dealership funds
  // the customer's tax out of its own revenue and never bills anyone for it.
  // That is wrong, it is wrong on `main` today, and it is wrong on the
  // dealership's OWN sales — which is why it is not corrected here. Fixing it
  // moves `customerBillableMinor`, the AR subledger document and every owned
  // sale's revenue, and that is a change to make on its own evidence, not a
  // side effect of enabling agent basis.
  //
  // So the three candidate postings, and why each is refused:
  //
  //   - Bill the tax on top (correct): needs `customerBillableMinor` to include
  //     it, or the GL's AR debit and the AR subledger diverge by the tax. That
  //     is the owned-sale change above.
  //   - Carve it out of the margin (the principal rule's convention): a 16% tax
  //     routinely EXCEEDS an agent's spread, so this refuses ordinary taxed
  //     consigned deals — a conditional refusal that fires nearly always is
  //     worse than an explicit one.
  //   - Charge it to the supplier: he is the principal, so it is arguable — and
  //     it is exactly the tax policy this rule may not invent.
  //
  // Production carries no taxed sale at all, so nothing real is blocked by
  // waiting for that decision. The sale form warns before submit rather than
  // letting an operator meet this as a failed save; see `consignedTaxRefusal`.
  const taxMinor = p.taxMinor && p.taxMinor > 0 ? p.taxMinor : 0;
  if (taxMinor > 0) {
    // `ConvexError`, not `Error`. Convex redacts a plain Error's message from a
    // production deployment, and `lib/errors.ts` then shows "An unexpected
    // error occurred" — on a form whose only fix is clearing a tax field the
    // operator has no reason to suspect. A refusal that cannot say what it
    // wants is a dead end, not a decision point.
    throw new ConvexError(
      `Consigned sale ${p.saleId} carries ${taxMinor} minor units of sales tax, and agency sales have no agreed tax treatment yet: the dealership sells this car as ${supplier}'s agent, so whether the tax is his liability or its own changes which of them the money is owed by. Record the tax against the supplier agreement, or sell the car as dealership stock, before completing the sale.`
    );
  }
  const commissionMinor = marginMinor;

  // A zero margin is a real deal, not a broken one: the dealership placed the
  // car for a supplier and made nothing on the metal, earning only the dealer
  // fees and F&I below. The journal simply has no commission line to write —
  // `validateBalance` rejects a 0/0 line, so emitting one made the whole sale
  // uncompletable rather than recording a fact worth recording. Where the
  // dealership's own minimum-profit policy objects, that is for
  // `convex/utils/profitApproval.ts` to raise as an approval, not for the
  // ledger to make structurally unrepresentable.
  const lines: LineSpec[] =
    consignment.settlementRoute === "DIRECT_TO_SUPPLIER"
      ? marginMinor > 0
        ? [
            // The buyer paid the supplier. Nothing gross ever reaches these
            // books; the only asset is the margin he now owes back.
            line(SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, marginMinor, 0, `Commission due from ${supplier}`, dims),
            line(SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, marginMinor, "Consignment commission earned", dims),
          ]
        : []
      : [
          // Gross landed here on his behalf: an asset for the whole amount, of
          // which his share is a liability from the instant it arrives.
          //
          // AP-Suppliers rather than a separate clearing account, because this
          // is the balance `sourcingPayables.markPaid` discharges. A dedicated
          // clearing account read better and settled never: the sale credited
          // one account and the payment debited another, so the liability stood
          // forever while the payment's debit landed somewhere nothing had
          // credited.
          line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.saleAmountMinor, 0, "Consigned sale proceeds receivable", dims),
          line(SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, entitlementMinor, `Owed to ${supplier}`, dims),
          // No tax line: `taxMinor` cannot be non-zero here, because the
          // refusal above returns first. One used to sit at this point, and it
          // was worse than dead — it credited SALES_TAX_PAYABLE without a
          // matching debit anywhere, so the entry was short by exactly the tax
          // and only the refusal above kept it from ever posting. Whoever
          // lifts that refusal must add the debit side too; see the note there
          // for which one.
          // Omitted at zero margin for the same reason as above; the AR and AP
          // lines already balance each other when the entitlement is the whole
          // price, so the entry stays valid without it.
          ...(commissionMinor > 0
            ? [line(SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, commissionMinor, "Consignment commission earned", dims)]
            : []),
        ];

  // Dealer fees and F&I products are the dealership's own income on its own
  // services, not the supplier's car — they are unaffected by who owned it.
  const dealerFeesMinor = p.dealerFeesMinor && p.dealerFeesMinor > 0 ? p.dealerFeesMinor : 0;
  if (dealerFeesMinor > 0) {
    lines.push(line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, dealerFeesMinor, 0, "Dealer fees receivable", dims));
    lines.push(line(SYSTEM_KEYS.DEALER_FEE_INCOME, 0, dealerFeesMinor, "Dealer fee income", dims));
  }
  const warrantySoldMinor = p.warrantySoldMinor && p.warrantySoldMinor > 0 ? p.warrantySoldMinor : 0;
  if (warrantySoldMinor > 0) {
    lines.push(line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, warrantySoldMinor, 0, "Warranty receivable", dims));
    addResoldProductLines(lines, warrantySoldMinor, p.warrantyCostMinor ?? 0, "Warranty", dims);
  }
  const gapSoldMinor = p.gapSoldMinor && p.gapSoldMinor > 0 ? p.gapSoldMinor : 0;
  if (gapSoldMinor > 0) {
    lines.push(line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, gapSoldMinor, 0, "GAP receivable", dims));
    addResoldProductLines(lines, gapSoldMinor, p.gapCostMinor ?? 0, "GAP", dims);
  }

  // A zero-margin direct-settled sale with no dealer fees and no F&I: the buyer
  // paid the supplier, the dealership placed the car and earned nothing, and
  // not one dinar passed through these books. That is a real deal with no
  // accounting consequence — so it is declared as such rather than returned as
  // an empty line array that `validateBalance` would wave through into a
  // journal entry with no lines.
  if (lines.length === 0) {
    return {
      lines,
      memo: `Consigned vehicle placed for ${supplier} — no dealership income on the deal`,
      category: "SYSTEM",
      skipPosting: true,
    };
  }

  return { lines, memo: `Consigned vehicle sold as agent for ${supplier}`, category: "SYSTEM" };
}

export function ruleSaleCompleted(p: SaleCompletedPayload): RuleResult {
  // Agent basis is a different rule, not a variation of this one — every line
  // below assumes the dealership owned what it sold.
  if (p.consignment) return consignedAgentSaleLines(p);

  // Fail closed, and loudly. A sourced vehicle is the supplier's, so reaching
  // the principal branch without consignment details means the caller is about
  // to book revenue on a car the dealership never owned and relieve inventory
  // it never held. Silence here is what put every historical sourced sale on
  // the books at gross — see convex/sourcedAgentImpact.ts. Converting the car
  // to owned stock is the other legitimate answer, and it has to be done on
  // purpose rather than implied by a missing field.
  //
  // Scoped to events whose emitter knew about agent basis. A legacy event
  // queued before this deploy carries no such knowledge, and refusing it would
  // dead-letter a real sale rather than book it — see `consignmentEvaluated`.
  if (p.isSourced && p.consignmentEvaluated) {
    throw new Error(
      `Sale ${p.saleId} is of a sourced vehicle, which is legally the supplier's. Post it on agent basis with the supplier's entitlement, or convert the vehicle to dealer-owned stock first — it cannot be posted as an owned sale.`
    );
  }
  // Reached by a legacy sourced event: it posts at gross exactly as it would
  // have before agent basis existed, and `migrateConsignedSaleBasis` restates
  // it afterwards along with every other historical sourced sale. Recorded in
  // the memo so the entry is identifiable without reconstructing why.
  const legacySourced = p.isSourced === true && p.consignmentEvaluated !== true;

  // `saleAmountMinor` is tax-EXCLUSIVE, so the whole of it is revenue and the
  // tax is billed on top of it (SCRUM-22).
  //
  // This rule used to read the same number as tax-INCLUSIVE: revenue was
  // `saleAmountMinor - taxMinor` and the AR debit carried no tax at all. For a
  // 20,000 sale at 16% that posted Dr AR 20,000 / Cr Revenue 16,800 / Cr Tax
  // 3,200 while the customer was invoiced 23,200 — the dealership funded the
  // customer's tax out of its own revenue and never billed anyone for it.
  //
  // Revenue and AR were understated by exactly the same amount, so the entry
  // BALANCED. `validateBalance` cannot see this class of defect, which is why
  // `ownedSaleTaxPosting.test.ts` asserts per-account amounts.
  //
  // The convention is not chosen here — it is read off the producers, which
  // never disagreed with each other. `applySaleCompletionSideEffects` passes
  // `args.salePrice` with `args.taxAmount` alongside it, `completeMultiVehicleSale`
  // computes `unitPrice * taxRate/100` additively, and `SaleDialog` bills
  // `salePrice + taxAmount + fees + …`. Only this rule read it the other way.
  const taxMinor = p.taxMinor && p.taxMinor > 0 ? p.taxMinor : 0;
  const revenueMinor = p.saleAmountMinor;
  const dims = { customerId: p.customerId, vehicleId: p.vehicleId, salespersonId: p.salespersonId };
  const dealerFeesMinor = p.dealerFeesMinor && p.dealerFeesMinor > 0 ? p.dealerFeesMinor : 0;
  const warrantySoldMinor = p.warrantySoldMinor && p.warrantySoldMinor > 0 ? p.warrantySoldMinor : 0;
  const gapSoldMinor = p.gapSoldMinor && p.gapSoldMinor > 0 ? p.gapSoldMinor : 0;
  // Must stay equal to `customerBillableMinor` in utils/saleCompletion.ts, which
  // sizes the canonical receivable document for the same sale. The GL and the
  // AR subledger disagreeing about one customer's bill is the failure this
  // arithmetic is shared to prevent.
  const arDebitMinor =
    p.saleAmountMinor + taxMinor + dealerFeesMinor + warrantySoldMinor + gapSoldMinor;
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, arDebitMinor, 0, "Sale receivable", dims),
    line(SYSTEM_KEYS.SALES_REVENUE, 0, revenueMinor, "Vehicle sale revenue", dims),
  ];
  if (dealerFeesMinor > 0) {
    lines.push(line(SYSTEM_KEYS.DEALER_FEE_INCOME, 0, dealerFeesMinor, "Dealer fee income", dims));
  }
  if (warrantySoldMinor > 0) {
    addResoldProductLines(lines, warrantySoldMinor, p.warrantyCostMinor ?? 0, "Warranty", dims);
  }
  if (gapSoldMinor > 0) {
    addResoldProductLines(lines, gapSoldMinor, p.gapCostMinor ?? 0, "GAP", dims);
  }
  if (taxMinor > 0) {
    lines.push(line(SYSTEM_KEYS.SALES_TAX_PAYABLE, 0, taxMinor, "Sales tax payable", { vehicleId: p.vehicleId }));
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
  return {
    lines,
    memo: legacySourced
      ? "Vehicle sale completed (sourced, principal basis — queued before agent accounting; awaiting restatement)"
      : "Vehicle sale completed",
    category: "SYSTEM",
  };
}

export interface ConsignedSaleReclassifiedPayload {
  saleId: string;
  vehicleId: string;
  customerId: string;
  currency: string;
  /** Vehicle revenue the principal posting recognized, now removed in full. */
  revenueMinor: number;
  /** The dealership's spread over the supplier's entitlement, recognized instead. */
  commissionMinor: number;
  /** Fabricated cost of a car the dealership never owned, now removed in full. */
  cogsMinor: number;
}

/**
 * Restates one historical consigned sale from principal to agent basis.
 *
 * The original posting booked the gross as revenue and the supplier's
 * entitlement as cost of sales. Both are wrong on a car the dealership never
 * owned, but they offset, so the sale's contribution to profit was already
 * right. That is the entire reason this correction is safe to automate: it
 * moves four account balances and leaves net income exactly where it was.
 *
 *   Dr  Sales Revenue                    (the gross that was never revenue)
 *     Cr  Consignment Commission Revenue (the spread, which is)
 *     Cr  Cost of Vehicles Sold          (the cost that was never incurred)
 *
 * Nothing on the balance sheet moves. The principal posting debited
 * AR-Customers for the gross and credited AP-Suppliers for the entitlement, and
 * agent basis on the THROUGH_DEALERSHIP route does exactly the same — so those
 * two are already correct and must not be touched. A sale where they are NOT
 * correct (inventory relieved, no supplier cost, a profit that would move) is
 * flagged by the impact report and never reaches this rule.
 *
 * The balance check is an assertion about the caller's arithmetic, not a
 * validation of user input: revenue removed must equal commission recognized
 * plus cost removed, or the entry changes profit and the premise has failed.
 */
export function ruleConsignedSaleReclassified(p: ConsignedSaleReclassifiedPayload): RuleResult {
  if (p.revenueMinor !== p.commissionMinor + p.cogsMinor) {
    throw new Error(
      `Consigned reclassification for sale ${p.saleId} would change reported profit: removing ${p.revenueMinor} of revenue against ${p.commissionMinor} commission and ${p.cogsMinor} cost. Refusing to post.`
    );
  }
  if (p.revenueMinor <= 0) {
    throw new Error(
      `Consigned reclassification for sale ${p.saleId} has no revenue to reclassify — it is already on agent basis. Refusing to post an empty correction.`
    );
  }

  const dims = { customerId: p.customerId, vehicleId: p.vehicleId };
  const lines: LineSpec[] = [
    line(SYSTEM_KEYS.SALES_REVENUE, p.revenueMinor, 0, "Vehicle revenue removed — sold as agent", dims),
  ];
  // A zero line is rejected by validateBalance, and both of these are
  // legitimately zero: a sale at exactly the supplier's entitlement earns no
  // commission, and a sale posted without a cost basis booked no COGS.
  if (p.commissionMinor > 0) {
    lines.push(line(SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, p.commissionMinor, "Consignment commission recognized", dims));
  }
  if (p.cogsMinor > 0) {
    lines.push(line(SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, 0, p.cogsMinor, "Cost removed — vehicle was never owned", dims));
  }

  return {
    lines,
    memo: "Consigned sale restated to agent basis",
    category: "ADJUSTMENT",
  };
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

export interface SupplierReceivableCollectedPayload {
  receivableId: string;
  sourcedFromName: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  vehicleId?: string;
}

/**
 * The supplier pays back the dealership's agency margin on a consigned deal he
 * collected the gross for.
 *
 * The exact reverse of the claim the sale opened: `consignedAgentSaleLines`
 * debits Receivable from Suppliers on the DIRECT_TO_SUPPLIER route, and this is
 * the only thing that brings it down. Without it the account accreted every
 * margin ever earned that way and nothing could ever discharge it — an asset
 * that only grows is not an asset, it is a hole in the ledger.
 *
 * Revenue is deliberately untouched. The margin was recognized when the sale
 * completed; this is collection, not a second earning of it.
 */
export function ruleSupplierReceivableCollected(p: SupplierReceivableCollectedPayload): RuleResult {
  // Inbound money, so the cheque case is a cheque the dealership HOLDS —
  // cashAccountKey, not disbursementAccountKey.
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, `Received from ${p.sourcedFromName}`, { vehicleId: p.vehicleId }),
      line(SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, 0, p.amountMinor, `Commission collected from ${p.sourcedFromName}`, { vehicleId: p.vehicleId }),
    ],
    memo: `Supplier commission received — ${p.sourcedFromName}`,
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
  const disbursementKey = disbursementAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, p.amountMinor, 0, "AR reopened by refund", { customerId: p.customerId }),
      line(disbursementKey, 0, p.amountMinor, "Refund paid out", { customerId: p.customerId }),
    ],
    memo: "Collection payment refunded",
    category: "SYSTEM",
  };
}

/**
 * Single source of truth for how a paid expense is booked, so ruleExpensePosted
 * (which posts it) and hookExpensePosted (which self-heals the target accounts)
 * can never disagree: a vehicle-linked recon cost capitalizes into inventory;
 * otherwise a prepaid expense becomes a balance-sheet asset; otherwise it's an
 * immediate period expense. Inventory capitalization wins over prepaid.
 */
export function classifyExpensePosting(args: {
  capitalizeToInventory?: boolean;
  vehicleId?: unknown;
  isPrepaid?: boolean;
}): { capitalize: boolean; prepaid: boolean } {
  const capitalize = args.capitalizeToInventory === true && !!args.vehicleId;
  const prepaid = args.isPrepaid === true && !capitalize;
  return { capitalize, prepaid };
}

export function ruleExpensePosted(p: ExpensePostedPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  const { capitalize, prepaid } = classifyExpensePosting(p);
  const debitKey = capitalize
    ? SYSTEM_KEYS.VEHICLE_INVENTORY
    : prepaid
      ? SYSTEM_KEYS.PREPAID_EXPENSES
      : expenseAccountKeyForCategory(p.category);
  const label = capitalize
    ? "Vehicle reconditioning cost capitalized"
    : prepaid
      ? "Prepaid expense capitalized"
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
    memo: capitalize
      ? "Vehicle reconditioning cost posted"
      : prepaid ? "Prepaid expense posted" : "Expense posted",
    category: "SYSTEM",
  };
}

/**
 * Monthly release of one term-month of a prepaid expense from the Prepaid
 * Expenses asset into its operating-expense account — the balance-sheet-to-P&L
 * half of the prepaid lifecycle whose asset half ruleExpensePosted booked.
 * `expenseSystemKey` is the exact expense account the original expense would
 * have hit, carried on the schedule so recognition never re-derives it. Same
 * debit-the-thing-being-released / credit-nothing-new shape as
 * ruleFiCommissionRecognized.
 */
export function rulePrepaidExpenseAmortized(p: PrepaidExpenseAmortizedPayload): RuleResult {
  return {
    lines: [
      line(p.expenseSystemKey as SystemKey, p.amountMinor, 0, "Prepaid expense amortized"),
      line(SYSTEM_KEYS.PREPAID_EXPENSES, 0, p.amountMinor, "Prepaid expense asset released"),
    ],
    memo: "Monthly prepaid expense amortization",
    category: "SYSTEM",
  };
}

export interface PrepaidExpenseRefundedPayload {
  scheduleId: string;
  amountMinor: number; // net (ex-VAT) refund, released from the Prepaid Expenses asset
  taxMinor?: number; // VAT portion of the refund, reclaimed from VAT_RECEIVABLE
  currency: string;
  paymentMethod?: string;
}

/**
 * A vendor refunds the unused (not-yet-recognized) portion of a prepaid
 * expense in cash/bank — the reverse cash-flow of ruleExpensePosted's prepaid
 * line, for exactly the unused remainder rather than the whole asset. When the
 * refund includes VAT (the vendor returns the input tax too, not just the net
 * cost), a third line reclaims it from VAT_RECEIVABLE — same net/tax split
 * ruleExpensePosted uses on the way in, mirrored on the way out. Byte-identical
 * two-line output for the tax-free case (taxMinor 0/undefined).
 */
export function rulePrepaidExpenseRefunded(p: PrepaidExpenseRefundedPayload): RuleResult {
  const taxMinor = p.taxMinor ?? 0;
  const lines: LineSpec[] = [
    line(cashAccountKey(p.paymentMethod), p.amountMinor + taxMinor, 0, "Prepaid expense refund received"),
    line(SYSTEM_KEYS.PREPAID_EXPENSES, 0, p.amountMinor, "Prepaid expense asset released (refund)"),
  ];
  if (taxMinor > 0) {
    lines.push(line(SYSTEM_KEYS.VAT_RECEIVABLE, 0, taxMinor, "Input VAT reclaimed on refund"));
  }
  return {
    lines,
    memo: "Prepaid expense partially refunded",
    category: "SYSTEM",
  };
}

/**
 * Same shape as rulePrepaidExpenseAmortized (release the asset into its
 * operating-expense account) but for a non-refundable unused remainder being
 * expensed immediately on early cancellation/write-off, rather than ratably
 * over the remaining term — a distinct eventType so the GL and reports can
 * tell an accelerated write-off apart from ordinary monthly recognition.
 */
export function rulePrepaidExpenseWrittenOff(p: PrepaidExpenseAmortizedPayload): RuleResult {
  return {
    lines: [
      line(p.expenseSystemKey as SystemKey, p.amountMinor, 0, "Prepaid expense written off"),
      line(SYSTEM_KEYS.PREPAID_EXPENSES, 0, p.amountMinor, "Prepaid expense asset released (write-off)"),
    ],
    memo: "Prepaid expense unused balance written off",
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

/**
 * Corrects a commission already recognized in the ledger, by the SIGNED delta
 * between the new amount and the accrued one. A correction is a new economic
 * event, never an edit of the original journal: the original entry and every
 * adjustment stay on the books so the decision history is auditable.
 *
 * Upward — Dr Commission Expense / Cr Commission Payable (more is owed).
 * Downward — the mirror image, which also covers a commission corrected to
 * zero: the delta then equals the full accrued amount and the payable nets out.
 *
 * A zero delta is refused rather than posted: an empty journal entry carries no
 * information and would make the adjustment sequence lie about how many real
 * corrections happened. Callers must not post when nothing changed.
 */
export function ruleCommissionAdjusted(p: CommissionAdjustedPayload): RuleResult {
  const amountMinor = Math.abs(p.deltaMinor);
  if (amountMinor === 0) {
    throw new Error("COMMISSION_ADJUSTED with a zero delta — refusing to post an empty journal entry");
  }
  const lines: LineSpec[] = p.deltaMinor > 0
    ? [
        line(SYSTEM_KEYS.COMMISSION_EXPENSE, amountMinor, 0, "Commission corrected upward", { salespersonId: p.salespersonId }),
        line(SYSTEM_KEYS.COMMISSION_PAYABLE, 0, amountMinor, "Commission payable increased", { salespersonId: p.salespersonId }),
      ]
    : [
        line(SYSTEM_KEYS.COMMISSION_PAYABLE, amountMinor, 0, "Commission payable reduced", { salespersonId: p.salespersonId }),
        line(SYSTEM_KEYS.COMMISSION_EXPENSE, 0, amountMinor, "Commission corrected downward", { salespersonId: p.salespersonId }),
      ];
  return { lines, memo: "Commission adjusted", category: "ADJUSTMENT" };
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

export interface TradeInAcceptedPayload {
  vehicleId: string;
  saleId: string;
  customerId: string;
  tradeInValueMinor: number;
  currency: string;
}

/**
 * A trade-in vehicle nets against the sale's AR instead of being paid for in
 * cash: debit Vehicle Inventory to capitalize the incoming vehicle at its
 * appraised value, credit AR-Customers to reduce the receivable the sale just
 * created by the same amount — the customer only owes sale price minus
 * trade-in value going forward. Mirrors ruleVehicleAcquired's inventory debit,
 * but the credit side is always AR (never cash/bank/AP), same reasoning as
 * ruleDepositApplied's credit side for a deposit applied to a sale.
 */
export function ruleTradeInAccepted(p: TradeInAcceptedPayload): RuleResult {
  const dims = { vehicleId: p.vehicleId, customerId: p.customerId };
  return {
    lines: [
      line(SYSTEM_KEYS.VEHICLE_INVENTORY, p.tradeInValueMinor, 0, "Trade-in vehicle capitalized", dims),
      line(SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, 0, p.tradeInValueMinor, "Trade-in applied to sale", dims),
    ],
    memo: "Trade-in vehicle accepted",
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

export interface FiCommissionRecognizedPayload {
  deferralId: string;
  amountMinor: number;
  currency: string;
}

export interface PrepaidExpenseAmortizedPayload {
  scheduleId: string;
  amountMinor: number;
  currency: string;
  /** The operating-expense system key the released amount is booked to (e.g. RENT_EXPENSE). */
  expenseSystemKey: string;
}

/**
 * Monthly ratable recognition of a resold warranty/GAP product's margin —
 * exact same shape as ruleDepreciationPosted (debit the liability being
 * released, credit the revenue being recognized), just for a deferred
 * commission instead of a fixed asset. See recognizeDeferredCommissionForMonth.
 */
export function ruleFiCommissionRecognized(p: FiCommissionRecognizedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.DEFERRED_FI_COMMISSION, p.amountMinor, 0, "Deferred F&I commission released"),
      line(SYSTEM_KEYS.FI_COMMISSION_REVENUE, 0, p.amountMinor, "F&I commission recognized"),
    ],
    memo: "Monthly F&I commission recognition",
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
  // Outbound payment — same reasoning as disbursementAccountKey and
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

// ─── Payroll ──────────────────────────────────────────────────────────────────

export interface EmployeeAdvancePaidPayload {
  advanceId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
}

/** Advance issued to an employee: Dr Employee Advances (asset) / Cr cash. */
export function ruleEmployeeAdvancePaid(p: EmployeeAdvancePaidPayload): RuleResult {
  // Outbound: a CHEQUE here is one the dealership WRITES, so it comes out of
  // the bank — never out of CHEQUES_IN_HAND (customer cheques we hold).
  const cashKey = disbursementAccountKey(p.paymentMethod);
  return {
    lines: [
      line(SYSTEM_KEYS.EMPLOYEE_ADVANCES, p.amountMinor, 0, "Employee advance issued"),
      line(cashKey, 0, p.amountMinor, "Advance paid to employee"),
    ],
    memo: "Employee advance paid",
    category: "SYSTEM",
  };
}

/** Advance repaid directly by an employee (outside payroll): Dr cash / Cr Employee Advances. */
export function ruleEmployeeAdvanceRecovered(p: EmployeeAdvancePaidPayload): RuleResult {
  const cashKey = cashAccountKey(p.paymentMethod);
  return {
    lines: [
      line(cashKey, p.amountMinor, 0, "Advance repaid by employee"),
      line(SYSTEM_KEYS.EMPLOYEE_ADVANCES, 0, p.amountMinor, "Employee advance recovered"),
    ],
    memo: "Employee advance recovered",
    category: "SYSTEM",
  };
}

export interface PayrollAccruedPayload {
  runId: string;
  userId: string;
  amountMinor: number;
  currency: string;
}

/** Salary accrued at payroll-run approval: Dr Salaries Expense / Cr Salaries Payable. */
export function rulePayrollAccrued(p: PayrollAccruedPayload): RuleResult {
  return {
    lines: [
      line(SYSTEM_KEYS.SALARIES_EXPENSE, p.amountMinor, 0, "Salary expense"),
      line(SYSTEM_KEYS.SALARIES_PAYABLE, 0, p.amountMinor, "Salary payable"),
    ],
    memo: "Payroll accrued",
    category: "SYSTEM",
  };
}

export interface PayrollPaidPayload {
  itemId: string;
  userId: string;
  /** Gross salary being settled (clears Salaries Payable). */
  salaryMinor: number;
  /** Commission portion paid through payroll (clears Commission Payable) — Option A. */
  commissionMinor: number;
  /** Outstanding advance recovered from this payslip (credits Employee Advances). */
  advanceRecoveredMinor: number;
  /** Net cash actually disbursed = salary + commission − advanceRecovered. */
  netMinor: number;
  currency: string;
  paymentMethod?: string;
}

/**
 * One employee's payslip payment. Clears the salary + commission payables,
 * recovers any outstanding advance, and pays out the net in cash. Zero-value
 * legs are omitted so validateBalance never sees a 0/0 line; the remaining
 * legs always balance (debits salary+commission = credits advance+net).
 */
export function rulePayrollPaid(p: PayrollPaidPayload): RuleResult {
  // Outbound: a payroll CHEQUE is written by the dealership → credit the bank,
  // never CHEQUES_IN_HAND (that asset is customer cheques we hold).
  const cashKey = disbursementAccountKey(p.paymentMethod);
  const lines: LineSpec[] = [];
  if (p.salaryMinor > 0) lines.push(line(SYSTEM_KEYS.SALARIES_PAYABLE, p.salaryMinor, 0, "Salary settled"));
  if (p.commissionMinor > 0) {
    lines.push(line(SYSTEM_KEYS.COMMISSION_PAYABLE, p.commissionMinor, 0, "Commission settled via payroll"));
  }
  if (p.advanceRecoveredMinor > 0) {
    lines.push(line(SYSTEM_KEYS.EMPLOYEE_ADVANCES, 0, p.advanceRecoveredMinor, "Advance recovered from payroll"));
  }
  if (p.netMinor > 0) lines.push(line(cashKey, 0, p.netMinor, "Net pay disbursed"));
  // Defense-in-depth: the payroll caller skips all-zero payslips, but a
  // zero-line "journal entry" passes validateBalance trivially (0 === 0), so
  // fail closed here too rather than letting an empty entry post.
  if (lines.length === 0) {
    throw new Error("PAYROLL_PAID with no non-zero legs — refusing to post an empty journal entry");
  }
  return { lines, memo: "Payroll paid", category: "SYSTEM" };
}

export function applyPostingRule(eventType: string, payload: Record<string, unknown>): RuleResult {
  switch (eventType as EventType) {
    case "DEPOSIT_RECEIVED": return ruleDepositReceived(payload as unknown as DepositReceivedPayload);
    case "DEPOSIT_APPLIED": return ruleDepositApplied(payload as unknown as DepositAppliedPayload);
    case "DEPOSIT_APPLIED_TO_SETTLEMENT": return ruleDepositAppliedToSettlement(payload as unknown as DepositAppliedToSettlementPayload);
    case "DEPOSIT_REFUNDED": return ruleDepositRefunded(payload as unknown as DepositRefundedPayload);
    case "DEPOSIT_FORFEITED": return ruleDepositForfeited(payload as unknown as DepositForfeitedPayload);
    case "SALE_COMPLETED": return ruleSaleCompleted(payload as unknown as SaleCompletedPayload);
    case "CONSIGNED_SALE_RECLASSIFIED": return ruleConsignedSaleReclassified(payload as unknown as ConsignedSaleReclassifiedPayload);
    case "SALE_CANCELLED": return ruleSaleCancelled(payload as unknown as SaleCancelledPayload);
    case "CHEQUE_DEPOSITED": return ruleChequeDeposited(payload as unknown as ChequeDepositedPayload);
    case "COLLECTION_PAYMENT": return ruleCollectionPayment(payload as unknown as CollectionPaymentPayload);
    case "COLLECTION_REFUND": return ruleCollectionRefund(payload as unknown as CollectionRefundPayload);
    case "EXPENSE_POSTED": return ruleExpensePosted(payload as unknown as ExpensePostedPayload);
    case "CHEQUE_RECEIVED": return ruleChequeReceived(payload as unknown as ChequeReceivedPayload);
    case "CHEQUE_CLEARED": return ruleChequeClear(payload as unknown as ChequeClearedPayload);
    case "CHEQUE_RETURNED": return ruleChequeReturned(payload as unknown as ChequeReturnedPayload);
    case "COMMISSION_ACCRUED": return ruleCommissionAccrued(payload as unknown as CommissionAccruedPayload);
    case "COMMISSION_ADJUSTED": return ruleCommissionAdjusted(payload as unknown as CommissionAdjustedPayload);
    case "COMMISSION_PAID": return ruleCommissionPaid(payload as unknown as CommissionPaidPayload);
    case "FINANCE_DISBURSED": return ruleFinanceDisbursed(payload as unknown as FinanceDisbursedPayload);
    case "FINANCE_CASH_RECEIVED": return ruleFinanceCashReceived(payload as unknown as FinanceCashReceivedPayload);
    case "PAYMENT_LINK_RECEIVED": return rulePaymentLinkReceived(payload as unknown as PaymentLinkReceivedPayload);
    case "SUPPLIER_PAYMENT_SETTLED": return ruleSupplierPaymentSettled(payload as unknown as SupplierPaymentSettledPayload);
    case "SUPPLIER_RECEIVABLE_COLLECTED": return ruleSupplierReceivableCollected(payload as unknown as SupplierReceivableCollectedPayload);
    case "ASSET_CAPITALIZED": return ruleAssetCapitalized(payload as unknown as AssetCapitalizedPayload);
    case "DEPRECIATION_POSTED": return ruleDepreciationPosted(payload as unknown as DepreciationPostedPayload);
    case "FI_COMMISSION_RECOGNIZED": return ruleFiCommissionRecognized(payload as unknown as FiCommissionRecognizedPayload);
    case "PREPAID_EXPENSE_AMORTIZED": return rulePrepaidExpenseAmortized(payload as unknown as PrepaidExpenseAmortizedPayload);
    case "PREPAID_EXPENSE_REFUNDED": return rulePrepaidExpenseRefunded(payload as unknown as PrepaidExpenseRefundedPayload);
    case "PREPAID_EXPENSE_WRITTEN_OFF": return rulePrepaidExpenseWrittenOff(payload as unknown as PrepaidExpenseAmortizedPayload);
    case "ASSET_IMPAIRED": return ruleAssetImpaired(payload as unknown as AssetImpairedPayload);
    case "ASSET_DISPOSED": return ruleAssetDisposed(payload as unknown as AssetDisposedPayload);
    case "CAPITAL_CONTRIBUTED": return ruleCapitalContributed(payload as unknown as PartnerEquityMovementPayload);
    case "PARTNER_DREW": return rulePartnerDrew(payload as unknown as PartnerEquityMovementPayload);
    case "PROFIT_DISTRIBUTED": return ruleProfitDistributed(payload as unknown as PartnerEquityMovementPayload);
    case "CLAIM_SETTLED": return ruleClaimSettled(payload as unknown as ClaimSettledPayload);
    case "CLAIM_WRITTEN_OFF": return ruleClaimWrittenOff(payload as unknown as ClaimWrittenOffPayload);
    case "CASH_DRAWER_DEPOSITED": return ruleCashDrawerDeposited(payload as unknown as CashDrawerDepositedPayload);
    case "EMPLOYEE_ADVANCE_PAID": return ruleEmployeeAdvancePaid(payload as unknown as EmployeeAdvancePaidPayload);
    case "EMPLOYEE_ADVANCE_RECOVERED": return ruleEmployeeAdvanceRecovered(payload as unknown as EmployeeAdvancePaidPayload);
    case "PAYROLL_ACCRUED": return rulePayrollAccrued(payload as unknown as PayrollAccruedPayload);
    case "PAYROLL_PAID": return rulePayrollPaid(payload as unknown as PayrollPaidPayload);
    case "VEHICLE_ACQUIRED": return ruleVehicleAcquired(payload as unknown as VehicleAcquiredPayload);
    case "TRADE_IN_ACCEPTED": return ruleTradeInAccepted(payload as unknown as TradeInAcceptedPayload);
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
