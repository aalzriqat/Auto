/**
 * Strips everything but digits and a leading "+" so phone numbers entered
 * in different formats (spaces, dashes, parens, local vs. international
 * prefixes) compare equal for duplicate detection.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/** Case-insensitive, whitespace-trimmed name comparison for fuzzy dedup nudges. */
export function namesSimilar(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
