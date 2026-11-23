import { getCodedErrorMessage, getErrorMessage } from "@/lib/errors";
import type { Translate } from "@/lib/i18n/dictionaries";

/**
 * Text for a failed key save. Returns a plain string so the caller can hand it
 * to `toast.error` without the raw error object (which the toast wrapper would
 * forward to Sentry). The server's coded refusals (`ServerError_<code>`) are
 * shown in the user's language. If the resulting text somehow contains the
 * submitted key, the generic message is shown instead: the input is never
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
  const text = getCodedErrorMessage(error, (key) => t(key as Parameters<Translate>[0])) ?? getErrorMessage(error);
  const trimmedKey = submittedKey.trim();
  if (trimmedKey.length > 0 && text.includes(trimmedKey)) return t("ServerError_AI_KEY_SAVE_FAILED");
  return text;
}
