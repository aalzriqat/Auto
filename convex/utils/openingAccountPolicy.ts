import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { resolveSystemAccount } from "../chartOfAccounts";
import { DEFAULT_CHART, SYSTEM_KEYS, type SystemKey } from "./defaultChart";
import { isOpeningPartnerAccount } from "../accounting/openingPartnerAllocations";

export type OpeningPolicy =
  | "LEDGER_ONLY"
  | "CUSTOMER_RECEIVABLE"
  | "EMPLOYEE_ADVANCE"
  | "PARTNER_CAPITAL"
  | "PREPAID_EXPENSE"
  | "VEHICLE_INVENTORY"
  | "SUPPLIER_RECOVERABLE"
  | "SUPPLIER_PAYABLE"
  | "OTHER_PAYABLE"
  | "EMPLOYEE_COMMISSION"
  | "UNALLOCATED_LIABILITY"
  | "DECLARED_LIABILITY"
  | "UNSUPPORTED";

// Exhaustive classification: a new system account requires an explicit opening
// decision. Unsupported operational controls cannot silently become GL-only.
const OPENING_POLICIES: Readonly<Record<string, OpeningPolicy | undefined>> = {
  CASH_ON_HAND: "LEDGER_ONLY",
  BANK_ACCOUNT: "LEDGER_ONLY",
  PAYMENT_CLEARING: "UNSUPPORTED",
  VAT_RECEIVABLE: "LEDGER_ONLY",
  ACCOUNTS_RECEIVABLE_CUSTOMERS: "CUSTOMER_RECEIVABLE",
  ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: "UNSUPPORTED",
  RECEIVABLE_FROM_SUPPLIERS: "SUPPLIER_RECOVERABLE",
  CONSIGNMENT_COMMISSION_REVENUE: "LEDGER_ONLY",
  UNAPPLIED_CUSTOMER_CASH: "UNSUPPORTED",
  UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY: "UNSUPPORTED",
  CUSTOMER_DEPOSITS_LIABILITY: "UNALLOCATED_LIABILITY",
  CHEQUES_IN_HAND: "UNSUPPORTED",
  CHEQUES_UNDER_COLLECTION: "UNSUPPORTED",
  VEHICLE_INVENTORY: "VEHICLE_INVENTORY",
  SALES_REVENUE: "LEDGER_ONLY",
  COST_OF_VEHICLES_SOLD: "LEDGER_ONLY",
  SALES_TAX_PAYABLE: "LEDGER_ONLY",
  REFUNDS_PAYABLE: "UNSUPPORTED",
  COMMISSION_EXPENSE: "LEDGER_ONLY",
  COMMISSION_PAYABLE: "EMPLOYEE_COMMISSION",
  GENERAL_EXPENSE: "LEDGER_ONLY",
  CASH_OVER_SHORT: "LEDGER_ONLY",
  RETAINED_EARNINGS: "LEDGER_ONLY",
  DEPOSIT_FORFEITURE_INCOME: "LEDGER_ONLY",
  ACCOUNTS_PAYABLE_SUPPLIERS: "SUPPLIER_PAYABLE",
  FIXED_ASSETS: "UNSUPPORTED",
  ACCUMULATED_DEPRECIATION: "UNSUPPORTED",
  DEPRECIATION_EXPENSE: "LEDGER_ONLY",
  GAIN_ON_DISPOSAL: "LEDGER_ONLY",
  LOSS_ON_DISPOSAL: "LEDGER_ONLY",
  IMPAIRMENT_LOSS: "LEDGER_ONLY",
  PARTNER_CAPITAL: "PARTNER_CAPITAL",
  PARTNER_DRAWINGS: "UNSUPPORTED",
  CLAIM_WRITE_OFF_EXPENSE: "LEDGER_ONLY",
  MISCELLANEOUS_INCOME: "LEDGER_ONLY",
  DEALER_FEE_INCOME: "LEDGER_ONLY",
  WARRANTY_GAP_PAYABLE: "UNSUPPORTED",
  DEFERRED_FI_COMMISSION: "UNSUPPORTED",
  FI_COMMISSION_REVENUE: "LEDGER_ONLY",
  RENT_EXPENSE: "LEDGER_ONLY",
  UTILITIES_EXPENSE: "LEDGER_ONLY",
  SALARIES_EXPENSE: "LEDGER_ONLY",
  SALARIES_PAYABLE: "UNSUPPORTED",
  EMPLOYEE_ADVANCES: "EMPLOYEE_ADVANCE",
  DEAL_CUSTODY_CLEARING: "UNSUPPORTED",
  EMPLOYEE_REIMBURSEMENTS_PAYABLE: "UNSUPPORTED",
  MARKETING_EXPENSE: "LEDGER_ONLY",
  OFFICE_EXPENSE: "LEDGER_ONLY",
  PROFESSIONAL_FEES_EXPENSE: "LEDGER_ONLY",
  PREPAID_EXPENSES: "PREPAID_EXPENSE",
  SALES_CONSIDERATION_REDUCTIONS: "LEDGER_ONLY",
  ACCOUNTS_PAYABLE_FINANCE_COMPANIES: "UNSUPPORTED",
  FINANCE_COMPANY_COMMISSION_EXPENSE: "LEDGER_ONLY",
  APPRAISAL_EXPENSE: "LEDGER_ONLY",
  INSURANCE_EXPENSE: "LEDGER_ONLY",
  OWNERSHIP_TRANSFER_EXPENSE: "LEDGER_ONLY",
  SELLING_EXPENSE: "LEDGER_ONLY",
} satisfies Record<SystemKey, OpeningPolicy>;

/** The writer and entry UI use one classification authority. A custom equity
 * account becomes capital only when the opening explicitly allocates it. */
export function openingPolicyForAccount(
  account: Doc<"chartOfAccounts">,
  explicitlyAllocatedCapital: boolean,
): OpeningPolicy | undefined {
  if (account.systemKey) return OPENING_POLICIES[account.systemKey];
  if (explicitlyAllocatedCapital && isOpeningPartnerAccount(account)) return "PARTNER_CAPITAL";
  if (account.type === "ASSET") return "SUPPLIER_RECOVERABLE";
  if (account.type === "LIABILITY") return "DECLARED_LIABILITY";
  return undefined;
}
export type RemainingOpeningKind =
  | "SUPPLIER_RECOVERABLE"
  | "SUPPLIER_PAYABLE"
  | "OTHER_PAYABLE"
  | "EMPLOYEE_COMMISSION"
  | "UNALLOCATED_LIABILITY"
  | "CUSTOMER_DEPOSIT";
export function isRemainingOpeningKind(
  kind: string,
): kind is RemainingOpeningKind {
  return [
    "SUPPLIER_RECOVERABLE",
    "SUPPLIER_PAYABLE",
    "OTHER_PAYABLE",
    "EMPLOYEE_COMMISSION",
    "UNALLOCATED_LIABILITY",
    "CUSTOMER_DEPOSIT",
  ].includes(kind);
}

/** A declared control cannot combine operational families or unidentified pools. Shared by
 * posting validation and reconciliation so stored declarations cannot invent a writer state. */
export function openingDeclaredFamilyRefusal(
  rows: readonly NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number][],
): string | null {
  if (rows.length === 0 || new Set(rows.map(row => row.kind)).size !== 1)
    return "Every opening control needs one explicitly declared allocation family.";
  if (rows[0].kind === "UNALLOCATED_LIABILITY" &&
    new Set(rows.map(row => "purpose" in row ? row.purpose : undefined)).size !== 1)
    return "Unidentified opening pools need separate declared controls.";
  return null;
}

export async function openingAccountAllowsFamily(
  ctx: QueryCtx | MutationCtx,
  orgId: Doc<"organizations">["_id"],
  account: Doc<"chartOfAccounts">,
  currency: string,
  kind: RemainingOpeningKind,
  purpose?: string,
): Promise<boolean> {
  if (!matchesOpeningAccountShape(account, orgId, currency, kind)) return false;
  // A named customer deposit is the native Customer Deposits liability, never a
  // custom account that merely looks like one (SCRUM-858 S1).
  if (!account.systemKey)
    return kind !== "CUSTOMER_DEPOSIT" && !DEFAULT_CHART.some((row) => row.code === account.code);
  const expected = openingFamilySystemKey(kind, purpose);
  if (expected === null || account.systemKey !== expected) return false;
  return (await resolveSystemAccount(ctx, orgId, expected)) === account._id;
}

function matchesOpeningAccountShape(account: Doc<"chartOfAccounts">,
  orgId: Doc<"organizations">["_id"], currency: string, kind: RemainingOpeningKind): boolean {
  if (
    account.orgId !== orgId ||
    !account.active ||
    (account.currencyRestriction !== undefined &&
      account.currencyRestriction !== currency) ||
    account.type !== (kind === "SUPPLIER_RECOVERABLE" ? "ASSET" : "LIABILITY")
  )
    return false;
  if (
    account.normalBalance !==
    (kind === "SUPPLIER_RECOVERABLE" ? "DEBIT" : "CREDIT")
  )
    return false;
  return true;
}

function openingFamilySystemKey(kind: RemainingOpeningKind, purpose?: string): SystemKey | null {
  switch (kind) {
    case "SUPPLIER_RECOVERABLE": return SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS;
    case "SUPPLIER_PAYABLE": return SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS;
    case "EMPLOYEE_COMMISSION": return SYSTEM_KEYS.COMMISSION_PAYABLE;
    case "UNALLOCATED_LIABILITY": return purpose === "CUSTOMER_DEPOSIT" ? SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY : null;
    case "CUSTOMER_DEPOSIT": return SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY;
    default: return null;
  }
}
