import { getCodedErrorMessage, getErrorMessage } from "@/lib/errors";
import type { Locale } from "@/lib/i18n/dictionaries";

export function collectionActionErrorMessage(error: unknown, locale: Locale, t: (key: string) => string): string {
  const translated = getCodedErrorMessage(error, t);
  return translated ?? (locale === "ar" ? t("UnexpectedError") : getErrorMessage(error));
}
