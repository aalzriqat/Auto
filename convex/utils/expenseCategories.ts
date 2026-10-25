import { EXPENSE_CATEGORIES } from "@autoflow/shared";
import { v } from "convex/values";

export const expenseCategoryValidator = v.union(...EXPENSE_CATEGORIES.map(category => v.literal(category)));
