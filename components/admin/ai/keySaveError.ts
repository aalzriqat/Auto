import { getErrorMessage } from "@/lib/errors";
import type { TranslationKey, Translate } from "@/lib/i18n/dictionaries";

/**
 * The fixed refusals `aiAdmin.saveProviderKey` can throw, mapped to their
 * translated text. Matching is exact: the server never puts the key in these.
 */
const KNOWN_REFUSALS: Readonly<Record<string, TranslationKey>> = {
  "The API key format is not valid.": "AiAdminKeyErrorFormat",
  "AI key encryption is not configured on this deployment.": "AiAdminKeyErrorEncryption",
  "The API key could not be saved. Please try again later.": "AiAdminKeyErrorGeneric",
};

/**
 * Text for a failed key save. Returns a plain string so the caller can hand it
 * to `toast.error` without the raw error object (which the toast wrapper would
 * forward to Sentry). If anything other than a known refusal somehow contains
 * the submitted key, the generic message is shown instead: the input is never
 * echoed.
 */
export function keySaveErrorMessage({
  error,
  submittedKey,
  t,
}: {
  error: unknown;
  submittedKey: string;
  t: Translate;
}): string {
  const serverMessage = getErrorMessage(error);
  const knownKey = KNOWN_REFUSALS[serverMessage];
  if (knownKey) return t(knownKey);
  const trimmedKey = submittedKey.trim();
  if (trimmedKey.length > 0 && serverMessage.includes(trimmedKey)) return t("AiAdminKeyErrorGeneric");
  return serverMessage;
}
