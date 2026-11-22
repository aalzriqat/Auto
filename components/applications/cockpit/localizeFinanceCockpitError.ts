import { getCodedErrorMessage, getErrorMessage, isConvexError } from "@/lib/errors";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { financeCockpitLegacyRefusals } from "@/lib/i18n/domains/financeCockpitErrors";

// The current server also emits plain-text refusals. Match known messages
// exactly so deployed backends can keep their existing error payloads.
const legacyRefusalKeys = new Map<string, TranslationKey>(
  (Object.keys(financeCockpitLegacyRefusals.en) as Array<keyof typeof financeCockpitLegacyRefusals.en>).map(
    (key) => [financeCockpitLegacyRefusals.en[key], key],
  ),
);
legacyRefusalKeys.set(
  "Record what was checked before reconciling this cost.",
  "ReconcileNotesRequired",
);

const adviceRefusalKeys = new Map<string, TranslationKey>([
  ["Application not found.", "FinanceSettlementAdviceApplicationUnavailable"],
  ["Idempotency key reused with different request content. Use a new key for a different operation.", "FinanceSettlementAdviceReviewRecorded"],
  ["This command is already being processed. Please retry shortly.", "FinanceSettlementAdviceInProgress"],
]);

function settlementAdviceRefusalKey(data: unknown, message: string): TranslationKey | undefined {
  if (typeof data === "object" && data !== null && "code" in data) {
    if (data.code === "UNAUTHENTICATED") {
      return "FinanceSettlementAdviceSignInRequired";
    }
    if (data.code === "FORBIDDEN" || data.code === "UNAUTHORIZED" || data.code === "ORG_NOT_FOUND") {
      return "FinanceSettlementAdviceAccessUnavailable";
    }
  }
  if (
    message.startsWith("Invalid minor-unit disbursed amount: ") &&
    message.endsWith(". Must be a non-negative safe integer.")
  ) {
    return "FinanceSettlementAdviceAmountInvalid";
  }
  return adviceRefusalKeys.get(message);
}

export function localizeFinanceCockpitError(
  error: unknown,
  t: (key: string) => string,
  scope?: "settlement-advice",
): string {
  const codedMessage = getCodedErrorMessage(error, t);
  if (codedMessage !== null) return codedMessage;
  if (!isConvexError(error)) {
    return t(scope === "settlement-advice" ? "FinanceSettlementAdviceOutcomeUnknown" : "UnexpectedError");
  }
  const message = getErrorMessage(error);
  const legacyKey =
    (scope === "settlement-advice" ? settlementAdviceRefusalKey(error.data, message) : undefined) ??
    legacyRefusalKeys.get(message);
  return t(legacyKey ?? "UnexpectedError");
}
