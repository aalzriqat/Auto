import { isConvexError } from "@autoflow/shared";
import { Alert } from "react-native";
import { hapticWarning } from "../../haptics";
import { useLocale } from "../../providers/LocaleProvider";
import { useGenericError, type AppLocale } from "./modules/moduleShared";

/**
 * SCRUM-533. `applications.createFromQuote` refuses a quote whose pricing disagrees with its own saved
 * pricing details with the structured code below. The text must stay equal to the web dictionary entry
 * `ServerError_QUOTE_PRICING_SNAPSHOT_MISMATCH` (lib/i18n/domains/sales.ts).
 */
export const QUOTE_PRICING_SNAPSHOT_MISMATCH_CODE = "QUOTE_PRICING_SNAPSHOT_MISMATCH";

const MESSAGES: Record<AppLocale, { title: string; message: string }> = {
  en: {
    title: "Could not start the application",
    message:
      "This quotation's pricing does not match its saved pricing details, so a finance application cannot be started from it. Create a new quotation and start the application from that.",
  },
  ar: {
    title: "تعذر بدء طلب التمويل",
    message:
      "لا يتطابق تسعير عرض السعر هذا مع تفاصيل التسعير المحفوظة له، لذلك لا يمكن بدء طلب تمويل منه. أنشئ عرض سعر جديداً وابدأ طلب التمويل منه.",
  },
};

/** The recovery alert for a quote-pricing refusal, or null for any other error. */
export function quotePricingMismatchAlert(
  error: unknown,
  locale: AppLocale,
): { title: string; message: string } | null {
  if (!isConvexError(error)) return null;
  const data = error.data;
  if (typeof data !== "object" || data === null) return null;
  return (data as { code?: unknown }).code === QUOTE_PRICING_SNAPSHOT_MISMATCH_CODE ? MESSAGES[locale] : null;
}

/** Error reporter for `createFromQuote` callers: the recovery alert for the known refusal, else the generic one. */
export function useApplicationCreateError() {
  const { locale } = useLocale();
  const reportError = useGenericError();
  return (context: string, error: unknown) => {
    const refusal = quotePricingMismatchAlert(error, locale);
    if (!refusal) {
      reportError(context, error);
      return;
    }
    console.error(context, error);
    hapticWarning();
    Alert.alert(refusal.title, refusal.message);
  };
}
