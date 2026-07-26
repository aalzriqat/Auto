/**
 * Generates a wa.me deep link that opens WhatsApp Desktop/Web/mobile with a
 * chat pre-filled — no Meta Cloud API call, no Business Verification, no
 * template approval. A human reviews and clicks send. See
 * docs/dealer_network_marketplace_master_plan.md §0.5/A5b for why this is
 * the V1 mechanism instead of an automated sender.
 *
 * Returns null when the phone has no dialable digits (e.g. a dealer config
 * field holding non-numeric text), mirroring this file's own `buildTelUrl`
 * and mobile's `buildWhatsappUrl` — never a dead `https://wa.me/` link.
 */
export function buildWhatsAppDeepLink(phone: string, message: string): string | null {
  const digitsOnly = phone.replace(/[^\d]/g, "");
  if (!digitsOnly) return null;
  return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}
