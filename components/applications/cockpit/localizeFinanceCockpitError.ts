import { getCodedErrorMessage, getErrorMessage, isConvexError } from "@/lib/errors";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { financeCockpitErrors } from "@/lib/i18n/domains/financeCockpitErrors";

// The current server also emits plain-text refusals. Match known messages
// exactly so deployed backends can keep their existing error payloads.
const legacyRefusalKeys = new Map<string, TranslationKey>(
  (Object.keys(financeCockpitErrors.en) as Array<keyof typeof financeCockpitErrors.en>).map(
    (key) => [financeCockpitErrors.en[key], key],
  ),
);
legacyRefusalKeys.set(
  "Record what was checked before reconciling this cost.",
  "ReconcileNotesRequired",
);

export function localizeFinanceCockpitError(
  error: unknown,
  t: (key: string) => string,
): string {
  const codedMessage = getCodedErrorMessage(error, t);
  if (codedMessage !== null) return codedMessage;
  const legacyKey = isConvexError(error) ? legacyRefusalKeys.get(getErrorMessage(error)) : undefined;
  return t(legacyKey ?? "UnexpectedError");
}
