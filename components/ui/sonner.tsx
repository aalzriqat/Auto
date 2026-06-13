"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, toast as originalToast } from "sonner"
import * as Sentry from "@sentry/nextjs"

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

  // Strip common framework prefixes (including nested "Uncaught ConvexError:" chains)
  rawMessage = rawMessage.replace(/(?:Uncaught\s+)?ConvexError:\s*/gi, "").trim();

  // Unwrap structured AppError JSON: {"code":"VEHICLE_NOT_FOUND","message":"..."}
  try {
    const parsed = JSON.parse(rawMessage);
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
      rawMessage = parsed.message;
    }
  } catch {
    // Not JSON — use rawMessage as-is
  }

  // Standard user-friendly keys and mappings
  const enTranslations: Record<string, string> = {
    // Member Account Validation
    "last_name": "Please enter both first and last name (Family Name is required).",
    "last name": "Please enter both first and last name (Family Name is required).",
    "email_address is already in use": "This email address is already in use by another account.",
    "that email address is taken": "This email address already has an account. Use the \"Add to Organization\" flow instead.",
    "username is already in use": "This username is already in use. Please choose a different one.",
    "missing data": "Required profile data is missing or invalid. Please check all fields.",
    "accountcreatedfail": "Failed to create account. Please verify input fields.",
    "password is required when creating": "A password is required when creating a new account.",
    "family name is required": "Family name is required. Please enter both first and last name.",
    
    // Auth & Permissions
    "unauthenticated": "You must be logged in to perform this action.",
    "unauthorized": "You do not have permission to perform this action.",
    "forbidden": "Access denied. Only the organization owner can perform this action.",
    
    // Entity Not Found errors
    "vehicle not found": "The requested vehicle could not be found in this organization.",
    "customer not found": "The requested customer could not be found in this organization.",
    "work order not found": "The requested work order could not be found.",
    "request not found": "The requested validation request could not be found.",
    "task not found": "The requested task could not be found.",
    "role not found": "The requested role could not be found.",
    "transaction not found": "The requested financial transaction could not be found.",
    "organization not found": "The organization could not be found.",
    "user not found": "User not found in the system. Please verify details.",
    
    // Dealership Business Logic
    "already have a pending status request": "You already have a pending status approval request for this vehicle.",
    "no changes detected": "No modifications were detected to save.",
    "request is already resolved": "This request has already been approved or rejected.",
    "this vehicle has already been sold": "This vehicle has already been sold and is no longer available.",
    "cannot sell an archived vehicle": "Cannot sell an archived vehicle. Please restore it first.",
    "salesperson is not a member": "The selected salesperson is not active in this organization.",
    "assigned user is not a member": "The assigned employee is not active in this organization.",
    "owner role cannot be renamed": "The Owner role is system-locked and cannot be renamed.",
    "owner role cannot be deleted": "The Owner role is system-locked and cannot be deleted.",
    "already a member of this organization": "This user is already a member of this organization.",
    "already an admin": "This user already has administrator privileges in this organization.",
    "member not found": "The specified member could not be found in this organization.",
    "cannot remove owner": "The organization owner cannot be removed from the organization.",
    "cannot change owner role": "The organization owner's role cannot be changed.",
    "role is in use": "This role is currently assigned to one or more members and cannot be deleted.",
    "permission denied": "You do not have the required permissions for this action.",
    "duplicate entry": "A record with this information already exists.",
    "already exists": "A record with this information already exists.",
    "test drive not found": "The requested test drive record could not be found.",
    "sale not found": "The requested sale record could not be found.",
    "financing application not found": "The financing application could not be found.",
    "document not found": "The requested document could not be found.",
    "image not found": "The requested image could not be found.",
    "quote not found": "The requested quote could not be found.",
    "cannot delete": "This record cannot be deleted because it is referenced by other records.",
    "invalid date": "Please enter a valid date.",
    "invalid price": "Please enter a valid price amount.",
    "invalid amount": "Please enter a valid amount.",
    "invalid phone": "Please enter a valid phone number.",
    "required field": "One or more required fields are missing. Please fill in all required fields.",
    
    // Media & Files
    "exceeds 5mb limit": "File size exceeds the 5MB upload limit.",
    "only image files are allowed": "Only image files (PNG, JPG, WEBP) are allowed for vehicles.",
    
    // Operations & Failures
    "failed to fetch": "Network connection error. Please check your internet connection.",
    "invalid vin": "Please check the VIN format and try again (17 characters required).",
    "invalid email": "Please check the email address formatting.",
    "vin decode warning": "Please verify the VIN code entered; some specifications could not be decoded.",
    "something went wrong": "An unexpected error occurred. Please try again later.",
    "failed to save work order": "Failed to save the work order. Please verify input fields.",
    "failed to save quote": "Failed to save the quote.",
    "failed to save test drive": "Failed to save test drive details.",
    "failed to generate quote": "Failed to generate the quote PDF.",
    "failed to generate pdf": "Failed to generate the PDF document.",
    "failed to create customer": "Failed to create customer record.",
    "failed to upload image": "Failed to upload vehicle image.",
    "exceeds financing limit": "The requested terms exceed the maximum permitted financing limit.",
    "failed to approve application": "Failed to approve this financing application.",
    "failed to finalize deal": "Failed to finalize the deal contract.",
    "failed to upload document": "Failed to upload document file.",
    "failed to create org": "Failed to create the new organization.",
    "failed to rename org": "Failed to rename the organization.",
  };

  const arTranslations: Record<string, string> = {
    // Member Account Validation
    "last_name": "يرجى إدخال الاسم الأول والأخير (اسم العائلة مطلوب).",
    "last name": "يرجى إدخال الاسم الأول والأخير (اسم العائلة مطلوب).",
    "email_address is already in use": "البريد الإلكتروني مستخدم بالفعل في حساب آخر.",
    "that email address is taken": "هذا البريد الإلكتروني مرتبط بحساب موجود. استخدم خيار \"الإضافة إلى المعرض\" بدلاً من ذلك.",
    "username is already in use": "اسم المستخدم هذا مستخدم بالفعل. يرجى اختيار اسم آخر.",
    "missing data": "البيانات المطلوبة مفقودة أو غير صالحة. يرجى التحقق من الحقول.",
    "accountcreatedfail": "فشل إنشاء الحساب. يرجى التحقق من الحقول المدخلة.",
    "password is required when creating": "كلمة المرور مطلوبة عند إنشاء حساب جديد.",
    "family name is required": "اسم العائلة مطلوب. يرجى إدخال الاسم الأول والأخير.",
    
    // Auth & Permissions
    "unauthenticated": "يجب تسجيل الدخول لإتمام هذا الإجراء.",
    "unauthorized": "ليس لديك الصلاحية لإتمام هذا الإجراء.",
    "forbidden": "تم رفض الوصول. مالك المعرض فقط من يمكنه القيام بهذا الإجراء.",
    
    // Entity Not Found errors
    "vehicle not found": "المركبة المطلوبة غير موجودة في سجلات هذا المعرض.",
    "customer not found": "العميل المطلوب غير موجود في سجلات هذا المعرض.",
    "work order not found": "أمر العمل المطلوب غير موجود.",
    "request not found": "الطلب المطلوب غير موجود.",
    "task not found": "المهمة المطلوبة غير موجودة.",
    "role not found": "الدور المطلوب غير موجود.",
    "transaction not found": "المعاملة المالية غير موجودة في سجلات هذا المعرض.",
    "organization not found": "المعرض المطلوب غير موجود.",
    "user not found": "المستخدم غير مسجل بالنظام. يرجى التأكد من التفاصيل.",
    
    // Dealership Business Logic
    "already have a pending status request": "لديك بالفعل طلب معلق لتغيير حالة هذه المركبة.",
    "no changes detected": "لم يتم اكتشاف أي تغييرات لحفظها.",
    "request is already resolved": "تمت تسوية أو البت في هذا الطلب بالفعل.",
    "this vehicle has already been sold": "تم بيع هذه المركبة بالفعل ولم تعد متاحة للبيع.",
    "cannot sell an archived vehicle": "لا يمكن بيع مركبة مؤرشفة. يرجى استعادتها أولاً.",
    "salesperson is not a member": "موظف المبيعات المعين ليس عضواً نشطاً في هذا المعرض.",
    "assigned user is not a member": "الموظف المعين ليس عضواً نشطاً في هذا المعرض.",
    "owner role cannot be renamed": "دور المالك مغلق من النظام ولا يمكن إعادة تسميته.",
    "owner role cannot be deleted": "دور المالك مغلق من النظام ولا يمكن حذفه.",
    "already a member of this organization": "هذا المستخدم عضو بالفعل في هذا المعرض.",
    "already an admin": "يمتلك هذا المستخدم صلاحيات مسؤول بالفعل في هذا المعرض.",
    "member not found": "العضو المحدد غير موجود في هذا المعرض.",
    "cannot remove owner": "لا يمكن إزالة مالك المعرض من المعرض.",
    "cannot change owner role": "لا يمكن تغيير دور مالك المعرض.",
    "role is in use": "هذا الدور مخصص لأحد الأعضاء حالياً ولا يمكن حذفه.",
    "permission denied": "ليس لديك الصلاحيات اللازمة لتنفيذ هذا الإجراء.",
    "duplicate entry": "يوجد سجل بهذه المعلومات بالفعل.",
    "already exists": "يوجد سجل بهذه المعلومات بالفعل.",
    "test drive not found": "سجل تجربة القيادة المطلوب غير موجود.",
    "sale not found": "سجل عملية البيع المطلوب غير موجود.",
    "financing application not found": "طلب التمويل غير موجود.",
    "document not found": "المستند المطلوب غير موجود.",
    "image not found": "الصورة المطلوبة غير موجودة.",
    "quote not found": "عرض السعر المطلوب غير موجود.",
    "cannot delete": "لا يمكن حذف هذا السجل لأنه مرتبط بسجلات أخرى.",
    "invalid date": "يرجى إدخال تاريخ صالح.",
    "invalid price": "يرجى إدخال مبلغ سعر صالح.",
    "invalid amount": "يرجى إدخال مبلغ صالح.",
    "invalid phone": "يرجى إدخال رقم هاتف صالح.",
    "required field": "حقل واحد أو أكثر مطلوب. يرجى ملء جميع الحقول الإلزامية.",
    
    // Media & Files
    "exceeds 5mb limit": "حجم الملف يتجاوز الحد الأقصى المسموح به (5 ميجابايت).",
    "only image files are allowed": "يسمح فقط بملفات الصور (PNG, JPG, WEBP) للمركبات.",
    
    // Operations & Failures
    "failed to fetch": "خطأ في الاتصال بالشبكة. يرجى التحقق من اتصالك بالإنترنت.",
    "invalid vin": "يرجى التحقق من رقم الشاصي (مطلوب 17 رمزاً).",
    "invalid email": "يرجى التحقق من صيغة البريد الإلكتروني.",
    "vin decode warning": "يرجى التحقق من رقم الشاصي المدخل؛ لم نتمكن من فك تشفير بعض البيانات.",
    "something went wrong": "حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى لاحقاً.",
    "failed to save work order": "فشل حفظ أمر العمل. يرجى التحقق من الحقول.",
    "failed to save quote": "فشل حفظ عرض السعر.",
    "failed to save test drive": "فشل حفظ تفاصيل تجربة القيادة.",
    "failed to generate quote": "فشل توليد عرض السعر بصيغة PDF.",
    "failed to generate pdf": "فشل إنشاء مستند PDF.",
    "failed to create customer": "فشل إنشاء سجل العميل.",
    "failed to upload image": "فشل رفع صورة المركبة.",
    "exceeds financing limit": "الشروط المطلوبة تتجاوز الحد الأقصى المسموح به للتمويل.",
    "failed to approve application": "فشل اعتماد طلب التمويل.",
    "failed to finalize deal": "فشل إتمام الصفقة نهائياً.",
    "failed to upload document": "فشل رفع مستند الملف.",
    "failed to create org": "فشل إنشاء المعرض الجديد.",
    "failed to rename org": "فشل إعادة تسمية المعرض.",
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
    if (message instanceof Error) {
      Sentry.captureException(message, { tags: { source: "toast" } });
    }
    const locale = typeof window !== "undefined"
      ? (localStorage.getItem("autoflow-locale") || "en")
      : "en";
    const friendlyMessage = formatFriendlyError(message, locale);
    return originalToast.error(friendlyMessage, options);
  }
}

export { Toaster }
