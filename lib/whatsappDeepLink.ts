/**
 * Generates a wa.me deep link that opens WhatsApp Desktop/Web/mobile with a
 * chat pre-filled — no Meta Cloud API call, no Business Verification, no
 * template approval. A human reviews and clicks send. See
 * docs/dealer_network_marketplace_master_plan.md §0.5/A5b for why this is
 * the V1 mechanism instead of an automated sender.
 */
export function buildWhatsAppDeepLink(phone: string, message: string): string {
  const digitsOnly = phone.replace(/[^\d]/g, "");
  return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}
