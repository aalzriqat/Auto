/** Existing native expense domain. Order is retained for rendered validator parity. */
export const EXPENSE_CATEGORIES = [
  "REPAIR", "MAINTENANCE", "DETAILING", "TRANSPORT", "MARKETING", "OFFICE",
  "SALARIES", "RENT", "UTILITIES", "FEES", "PREPAID", "OTHER",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type NonPrepaidExpenseCategory = Exclude<ExpenseCategory, "PREPAID">;

/** Category-name subset only; web expenses can still use isPrepaid with amortization fields. */
export const NON_PREPAID_EXPENSE_CATEGORIES = EXPENSE_CATEGORIES.filter(
  (category): category is NonPrepaidExpenseCategory => category !== "PREPAID",
);

export function isNonPrepaidExpenseCategory(value: unknown): value is NonPrepaidExpenseCategory {
  return typeof value === "string" && NON_PREPAID_EXPENSE_CATEGORIES.some(category => category === value);
}
