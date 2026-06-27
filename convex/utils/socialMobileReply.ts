export const DEFAULT_MOBILE_RECEIVED_AUTO_REPLY =
  "Thank you, we received your mobile number. Our sales team will contact you shortly.\n\n" +
  "شكراً، تم استلام رقم هاتفك وسيقوم فريق المبيعات بالتواصل معك قريباً.";

export function mobileReceivedAutoReplyText(customMessage: string | undefined): string {
  const trimmed = customMessage?.trim();
  return trimmed || DEFAULT_MOBILE_RECEIVED_AUTO_REPLY;
}
