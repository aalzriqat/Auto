import { format, type Locale } from "date-fns";
import { ar } from "date-fns/locale/ar";

/**
 * Locale-aware date formatting for pattern-based screens (SCRUM-417 UX5, S6).
 *
 * The cockpit formats dates with date-fns patterns ("d MMM yyyy"), and a bare
 * `format()` always speaks English, so an Arabic screen showed "12 Mar 2026"
 * next to Arabic labels. This only chooses the language of the month name: the
 * instant, the timezone and the digits (Western, as everywhere else in the
 * product) are unchanged.
 */
export function dateFnsLocale(locale: string | undefined): Locale | undefined {
  return locale === "ar" ? ar : undefined;
}

export function formatLocalized(
  value: number | Date,
  pattern: string,
  locale: string | undefined
): string {
  return format(value, pattern, { locale: dateFnsLocale(locale) });
}