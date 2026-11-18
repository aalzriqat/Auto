import { ConvexError } from "convex/values";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import type { DepositForfeitedPayload, RuleResult } from "./postingRules";

export function ruleDepositRefundReturned(payload: Record<string, unknown>): RuleResult {
  const { amountMinor, customerId, bankAccountId } = payload;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      typeof customerId !== "string" || !customerId || typeof bankAccountId !== "string" || !bankAccountId) {
    throw new ConvexError("The returned bank transfer has incomplete posting details.");
  }
  return {
    lines: [
      { accountSystemKey: SYSTEM_KEYS.BANK_ACCOUNT, debitMinor: amountMinor, creditMinor: 0,
        description: "Bank returned the deposit refund", bankAccountId, customerId },
      { accountSystemKey: SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, debitMinor: 0, creditMinor: amountMinor,
        description: "Opening deposit liability restored", customerId },
    ],
    memo: "Returned opening deposit bank refund",
    category: "SYSTEM",
  };
}

export function ruleDepositForfeited({ amountMinor, customerId }: DepositForfeitedPayload): RuleResult {
  return {
    lines: [
      { accountSystemKey: SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, debitMinor: amountMinor, creditMinor: 0,
        description: "Deposit forfeited", customerId },
      { accountSystemKey: SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME, debitMinor: 0, creditMinor: amountMinor,
        description: "Forfeiture income", customerId },
    ],
    memo: "Deposit forfeited",
    category: "SYSTEM",
  };
}
