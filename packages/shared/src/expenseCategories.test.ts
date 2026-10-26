import { expect, test } from "vitest";
import { isNonPrepaidExpenseCategory } from "./expenseCategories";

test.each(["REPAIR", "MAINTENANCE", "DETAILING", "TRANSPORT", "MARKETING", "OFFICE", "SALARIES", "RENT", "UTILITIES", "FEES", "OTHER"])(
  "%s is selectable by a form without amortization fields", value => { expect(isNonPrepaidExpenseCategory(value)).toBe(true); },
);
test.each(["PREPAID", "INSPECTION", "REGISTRATION", "CLEANING", "INSURANCE", "", null, undefined, 12, {}])(
  "%s cannot cross the non-prepaid category selection boundary", value => { expect(isNonPrepaidExpenseCategory(value)).toBe(false); },
);
