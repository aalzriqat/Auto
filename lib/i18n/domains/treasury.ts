import { defineBilingualMessages } from "../defineBilingualMessages";

const messages = defineBilingualMessages({
  BankStatementBalance: ["Balance on bank statement", "الرصيد حسب كشف الحساب"],
  BankStatementDate: ["Bank statement date", "تاريخ كشف الحساب"],
  BankStatementBalanceHelp: [
    "The statement amount is saved for comparison. Post the opening entry in Accounting Setup, or record how the new account was funded.",
    "يُحفظ مبلغ كشف الحساب للمقارنة. رحّل قيد الافتتاح من إعدادات المحاسبة، أو سجّل مصدر تمويل الحساب الجديد.",
  ],
  BankStatementAmountInvalid: [
    "Enter a valid amount with the currency's decimal precision.",
    "أدخل مبلغاً صحيحاً بعدد المنازل العشرية للعملة.",
  ],
  BankStatementAfterOpening: ["Statement after opening", "كشف لاحق للافتتاح"],
  BankStatementNotComparable: ["Statement cannot be compared to opening", "يتعذّر مقارنة كشف الحساب بالرصيد الافتتاحي"],
  BankTransfers: ["Account transfers", "التحويلات بين الحسابات"],
  BankTransferRecord: ["Record transfer", "تسجيل تحويل"],
  BankTransferReverse: ["Reverse transfer", "عكس التحويل"],
  BankTransferFrom: ["From", "من"],
  BankTransferTo: ["To", "إلى"],
  BankTransferChooseAccount: ["Choose an account", "اختر حساباً"],
  BankTransferDate: ["Transfer date", "تاريخ التحويل"],
  BankTransferReference: ["Confirmation reference", "مرجع التأكيد"],
  BankTransferEvidenceHelp: [
    "Enter a transfer that has already been confirmed. Cash transfers require a settled drawer.",
    "سجّل تحويلاً تم تأكيده بالفعل. تتطلب التحويلات النقدية صندوقاً تمت تسويته.",
  ],
  BankTransferCurrencyMismatch: ["Choose two accounts in the same currency.", "اختر حسابين بالعملة نفسها."],
  BankTransferRecorded: ["Transfer recorded.", "تم تسجيل التحويل."],
  BankTransferReversed: ["Transfer reversed.", "تم عكس التحويل."],
  BankTransferRecordFailed: [
    "The transfer could not be recorded. Check the accounts, posting date and cash drawer.",
    "تعذّر تسجيل التحويل. تحقّق من الحسابات وتاريخ الترحيل وحالة الصندوق.",
  ],
  BankTransferReverseFailed: [
    "The transfer could not be reversed. Check the date, cash drawer and bank reconciliation.",
    "تعذّر عكس التحويل. تحقّق من التاريخ والصندوق والمطابقة البنكية.",
  ],
  BankTransferHistoryUnavailable: ["Transfer history is unavailable.", "سجل التحويلات غير متاح."],
  BankTransferNone: ["No transfers recorded.", "لا توجد تحويلات مسجّلة."],
  BankTransferNewer: ["Newer transfers", "التحويلات الأحدث"],
  BankTransferOlder: ["Older transfers", "التحويلات الأقدم"],
  BankTransferReversalReason: ["Reason for reversal", "سبب عكس التحويل"],
  BankTransferReversalHelp: [
    "Record the reason for reversing this transfer. Remove any statement match first.",
    "سجّل سبب عكس هذا التحويل. ألغِ أي مطابقة لكشف الحساب أولاً.",
  ],
  DashboardBankTotal: ["Total bank accounts", "إجمالي الحسابات البنكية"],
  DashboardCashAndBankTotal: ["Total cash and bank accounts", "إجمالي النقد والحسابات البنكية"],
});

export const treasuryEn = messages.en;
export const treasuryAr = messages.ar;
