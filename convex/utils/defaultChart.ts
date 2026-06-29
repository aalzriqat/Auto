export const SYSTEM_KEYS = {
  CASH_ON_HAND: "CASH_ON_HAND",
  BANK_ACCOUNT: "BANK_ACCOUNT",
  PAYMENT_CLEARING: "PAYMENT_CLEARING",
  ACCOUNTS_RECEIVABLE_CUSTOMERS: "ACCOUNTS_RECEIVABLE_CUSTOMERS",
  ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES",
  UNAPPLIED_CUSTOMER_CASH: "UNAPPLIED_CUSTOMER_CASH",
  CUSTOMER_DEPOSITS_LIABILITY: "CUSTOMER_DEPOSITS_LIABILITY",
  CHEQUES_IN_HAND: "CHEQUES_IN_HAND",
  CHEQUES_UNDER_COLLECTION: "CHEQUES_UNDER_COLLECTION",
  VEHICLE_INVENTORY: "VEHICLE_INVENTORY",
  SALES_REVENUE: "SALES_REVENUE",
  COST_OF_VEHICLES_SOLD: "COST_OF_VEHICLES_SOLD",
  SALES_TAX_PAYABLE: "SALES_TAX_PAYABLE",
  REFUNDS_PAYABLE: "REFUNDS_PAYABLE",
  COMMISSION_EXPENSE: "COMMISSION_EXPENSE",
  COMMISSION_PAYABLE: "COMMISSION_PAYABLE",
  CASH_OVER_SHORT: "CASH_OVER_SHORT",
  RETAINED_EARNINGS: "RETAINED_EARNINGS",
  DEPOSIT_FORFEITURE_INCOME: "DEPOSIT_FORFEITURE_INCOME",
} as const;

export type SystemKey = typeof SYSTEM_KEYS[keyof typeof SYSTEM_KEYS];

export type AccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "REVENUE"
  | "COGS"
  | "EXPENSE"
  | "OTHER_INCOME"
  | "OTHER_EXPENSE";

export type NormalBalance = "DEBIT" | "CREDIT";

export interface DefaultAccountDef {
  code: string;
  name: string;
  nameAr: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isControlAccount: boolean;
  allowManualPosting: boolean;
  systemKey?: string;
  subtype?: string;
}

export const DEFAULT_CHART: DefaultAccountDef[] = [
  // ── Assets ───────────────────────────────────────────────────────────────
  {
    code: "1100",
    name: "Cash on Hand",
    nameAr: "النقد في الصندوق",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.CASH_ON_HAND,
  },
  {
    code: "1110",
    name: "Bank Account",
    nameAr: "الحساب البنكي",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.BANK_ACCOUNT,
  },
  {
    code: "1120",
    name: "Payment Clearing",
    nameAr: "مقاصة المدفوعات",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.PAYMENT_CLEARING,
  },
  {
    code: "1200",
    name: "Accounts Receivable — Customers",
    nameAr: "ذمم مدينة - عملاء",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: true,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
  },
  {
    code: "1210",
    name: "Accounts Receivable — Finance Companies",
    nameAr: "ذمم مدينة - شركات التمويل",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: true,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES,
  },
  {
    code: "1220",
    name: "Unapplied Customer Cash",
    nameAr: "نقد عملاء غير مطبق",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.UNAPPLIED_CUSTOMER_CASH,
  },
  {
    code: "1300",
    name: "Cheques in Hand",
    nameAr: "شيكات في الحوزة",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.CHEQUES_IN_HAND,
  },
  {
    code: "1310",
    name: "Cheques Under Collection",
    nameAr: "شيكات قيد التحصيل",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.CHEQUES_UNDER_COLLECTION,
  },
  {
    code: "1400",
    name: "Vehicle Inventory",
    nameAr: "مخزون السيارات",
    type: "ASSET",
    normalBalance: "DEBIT",
    isControlAccount: true,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.VEHICLE_INVENTORY,
  },

  // ── Liabilities ──────────────────────────────────────────────────────────
  {
    code: "2100",
    name: "Customer Deposits Liability",
    nameAr: "التزامات دفعات العملاء",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    isControlAccount: true,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY,
  },
  {
    code: "2200",
    name: "Sales Tax Payable",
    nameAr: "ضريبة المبيعات المستحقة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.SALES_TAX_PAYABLE,
  },
  {
    code: "2210",
    name: "Refunds Payable",
    nameAr: "مستردات مستحقة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.REFUNDS_PAYABLE,
  },
  {
    code: "2300",
    name: "Commission Payable",
    nameAr: "عمولات مستحقة",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.COMMISSION_PAYABLE,
  },

  // ── Equity ───────────────────────────────────────────────────────────────
  {
    code: "3100",
    name: "Retained Earnings",
    nameAr: "الأرباح المحتجزة",
    type: "EQUITY",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.RETAINED_EARNINGS,
  },

  // ── Revenue ──────────────────────────────────────────────────────────────
  {
    code: "4100",
    name: "Vehicle Sales Revenue",
    nameAr: "إيرادات بيع السيارات",
    type: "REVENUE",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.SALES_REVENUE,
  },
  {
    code: "4200",
    name: "Deposit Forfeiture Income",
    nameAr: "إيرادات مصادرة الدفعات",
    type: "OTHER_INCOME",
    normalBalance: "CREDIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME,
  },

  // ── COGS ─────────────────────────────────────────────────────────────────
  {
    code: "5100",
    name: "Cost of Vehicles Sold",
    nameAr: "تكلفة السيارات المباعة",
    type: "COGS",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.COST_OF_VEHICLES_SOLD,
  },

  // ── Expenses ─────────────────────────────────────────────────────────────
  {
    code: "6100",
    name: "Commission Expense",
    nameAr: "مصروف العمولات",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: false,
    systemKey: SYSTEM_KEYS.COMMISSION_EXPENSE,
  },
  {
    code: "6200",
    name: "Cash Over / Short",
    nameAr: "زيادة / نقص النقدية",
    type: "OTHER_EXPENSE",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: true,
    systemKey: SYSTEM_KEYS.CASH_OVER_SHORT,
  },
  {
    code: "6300",
    name: "General Expenses",
    nameAr: "مصاريف عامة",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isControlAccount: false,
    allowManualPosting: true,
  },
];

export const REQUIRED_SYSTEM_KEYS: SystemKey[] = [
  SYSTEM_KEYS.CASH_ON_HAND,
  SYSTEM_KEYS.BANK_ACCOUNT,
  SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
  SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY,
  SYSTEM_KEYS.VEHICLE_INVENTORY,
  SYSTEM_KEYS.SALES_REVENUE,
  SYSTEM_KEYS.COST_OF_VEHICLES_SOLD,
];
