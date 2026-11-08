import type { Doc } from "../../convex/_generated/dataModel";

// Custom accounts follow their type; system contra-account definitions are separate.
export const NORMAL_BALANCE_BY_ACCOUNT_TYPE = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  COGS: "DEBIT",
  EXPENSE: "DEBIT",
  OTHER_INCOME: "CREDIT",
  OTHER_EXPENSE: "DEBIT",
} as const satisfies Record<Doc<"chartOfAccounts">["type"], Doc<"chartOfAccounts">["normalBalance"]>;
