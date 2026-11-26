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
  BankLateOpeningTitle: ["Opening balances not yet posted", "أرصدة افتتاحية لم تُرحَّل بعد"],
  BankLateOpeningHelp: [
    "These banks were added after the opening entry, so their stated balance is not in the books yet. Posting it adds the balance to the bank against Opening suspense (1900). It can be done once per bank and cannot be undone.",
    "أُضيفت هذه البنوك بعد قيد الافتتاح، لذا لم يدخل رصيدها المصرّح به في الدفاتر بعد. يضيف الترحيل الرصيد إلى البنك مقابل حساب فروقات الافتتاح (1900). يتم مرة واحدة لكل بنك ولا يمكن التراجع عنه.",
  ],
  BankLateOpeningPost: ["Post opening balance", "ترحيل الرصيد الافتتاحي"],
  BankLateOpeningBank: ["Bank", "البنك"],
  BankLateOpeningAmount: ["Opening balance", "الرصيد الافتتاحي"],
  BankLateOpeningDate: ["Opening balance date", "تاريخ الرصيد الافتتاحي"],
  BankLateOpeningAgainst: [
    "Posted against Opening suspense (1900): debit the bank, credit Opening suspense.",
    "يُرحَّل مقابل حساب فروقات الافتتاح (1900): مدين البنك ودائن فروقات الافتتاح.",
  ],
  BankLateOpeningCannotNow: [
    "Cannot be posted now. Correct the balance or date, or check the accounting period.",
    "تعذّر الترحيل الآن. صحّح الرصيد أو التاريخ، أو تحقّق من الفترة المحاسبية.",
  ],
  BankLateOpeningPosted: ["Opening balance posted for this bank.", "تم ترحيل الرصيد الافتتاحي لهذا البنك."],
  BankLateOpeningPostedAfterCutover: ["Posted after opening", "رُحِّل بعد الافتتاح"],
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
