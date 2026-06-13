"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, toast as originalToast } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

// Global user-friendly error formatting utility
function formatFriendlyError(error: any, locale: string): string {
  if (!error) {
    return locale === "ar" 
      ? "حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى." 
      : "An unexpected error occurred. Please try again.";
  }

  let rawMessage = "";
  if (typeof error === "string") {
    rawMessage = error;
  } else if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === "object") {
    rawMessage = error.message || error.error || JSON.stringify(error);
  }

  // Strip common framework prefixes
  rawMessage = rawMessage.replace(/^ConvexError:\s*/i, "").trim();

  // Standard user-friendly keys and mappings
  const enTranslations: Record<string, string> = {
    "missing data": "Required profile data is missing or invalid. Please check all fields.",
    "unauthenticated": "You must be logged in to perform this action.",
    "unauthorized": "You do not have permission to perform this action.",
    "role_not_found": "The requested role could not be found.",
    "user_not_found": "The requested user could not be found.",
    "failed to fetch": "Network connection error. Please check your internet connection.",
    "invalid vin": "Please check the VIN format and try again.",
    "invalid email": "Please check the email address formatting.",
    "vin decode warning": "Please verify the VIN code entered; some specifications could not be decoded.",
    "accountcreatedfail": "Failed to create account. Please verify input fields.",
    "something went wrong": "An unexpected error occurred. Please try again later.",
  };

  const arTranslations: Record<string, string> = {
    "missing data": "البيانات المطلوبة مفقودة أو غير صالحة. يرجى التحقق من الحقول.",
    "unauthenticated": "يجب تسجيل الدخول لإتمام هذا الإجراء.",
    "unauthorized": "ليس لديك الصلاحية لإتمام هذا الإجراء.",
    "role_not_found": "الدور المطلوب غير موجود.",
    "user_not_found": "المستخدم المطلوب غير موجود.",
    "failed to fetch": "خطأ في الاتصال بالشبكة. يرجى التحقق من اتصالك بالإنترنت.",
    "invalid vin": "يرجى التحقق من رقم الشاصي والمحاولة مرة أخرى.",
    "invalid email": "يرجى التحقق من صيغة البريد الإلكتروني.",
    "vin decode warning": "يرجى التحقق من رقم الشاصي المدخل؛ لم نتمكن من فك تشفير بعض البيانات.",
    "accountcreatedfail": "فشل إنشاء الحساب. يرجى التحقق من الحقول المدخلة.",
    "something went wrong": "حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى لاحقاً.",
  };

  const lowerMessage = rawMessage.toLowerCase();

  // Search for partial matches
  for (const [key, value] of Object.entries(enTranslations)) {
    if (lowerMessage.includes(key)) {
      return locale === "ar" ? arTranslations[key] : value;
    }
  }

  // Generic formatting for database and account framework exceptions
  if (lowerMessage.includes("clerk") || lowerMessage.includes("form_data_missing") || lowerMessage.includes("last_name")) {
    return locale === "ar" 
      ? "فشل تسجيل البيانات في نظام الحسابات. يرجى التأكد من ملء جميع الحقول المطلوبة بشكل صحيح." 
      : "Account registry error. Please ensure all required form fields are completed correctly.";
  }

  // Return formatted raw message if not developer-heavy, otherwise generic
  if (rawMessage.length > 0 && !lowerMessage.includes("error:") && !lowerMessage.includes("uncaught") && !lowerMessage.includes("exception")) {
    return rawMessage;
  }

  return locale === "ar"
    ? "حدث خطأ أثناء معالجة الطلب. يرجى مراجعة المدخلات والمحاولة مرة أخرى."
    : "An error occurred while processing your request. Please review your inputs and try again.";
}

// Custom wrapped toast object with user-friendly formatting for error
export const toast = {
  ...originalToast,
  error: (message: any, options?: any) => {
    const locale = typeof window !== "undefined" 
      ? (localStorage.getItem("autoflow-locale") || "en") 
      : "en";
    const friendlyMessage = formatFriendlyError(message, locale);
    return originalToast.error(friendlyMessage, options);
  }
}

export { Toaster }
