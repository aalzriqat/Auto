/**
 * Generates a wa.me deep link that opens WhatsApp Desktop/Web/mobile with a
 * chat pre-filled. This only prepares a human-reviewed send surface; it does
 * not call the Meta Business API.
 */
export function buildWhatsAppDeepLink(phone: string, message: string): string {
  const digitsOnly = phone.replace(/[^\d]/g, "");
  return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}
