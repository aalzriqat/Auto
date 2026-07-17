/**
 * Extracts a safe in-app deep link from a push notification's data payload.
 * Only same-app absolute paths ("/...") are allowed — never a protocol-relative
 * "//host" or an external URL — so a tapped notification can't redirect the app
 * anywhere outside itself. Returns null when there's nothing safe to open.
 */
export function parseNotificationLink(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const link = (data as Record<string, unknown>).link;
  if (typeof link !== "string") return null;
  const trimmed = link.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed;
}
