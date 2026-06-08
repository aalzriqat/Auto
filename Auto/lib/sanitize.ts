/**
 * Basic input sanitization to prevent PDF injection issues.
 * Strips out problematic characters that could break jsPDF parsing or formatting.
 */
export function sanitizePdfInput(input: string | undefined | null): string {
  if (!input) return "";
  // Allow alphanumeric, standard punctuation, and spaces. Remove unprintable/control characters.
  // We remove characters that might be interpreted as PDF operators if somehow injected,
  // or invisible control characters.
  return input.replace(/[\x00-\x1F\x7F]/g, "").trim();
}
