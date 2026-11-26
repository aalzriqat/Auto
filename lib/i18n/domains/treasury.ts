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
  // SCRUM-1012. The English text must equal LATE_BANK_OPENING_MESSAGES in convex/accounting/lateBankOpening.ts.
  ServerError_LATE_BANK_OPENING_BANK_UNAVAILABLE: [
    "Choose an active bank account of this organization to post its opening balance.",
    "اختر حساباً بنكياً نشطاً من هذه المنشأة لترحيل رصيده الافتتاحي.",
  ],
  ServerError_LATE_BANK_OPENING_INVALID_BALANCE: [
    "This bank's stored opening balance or date cannot be posted. Correct it first. Nothing was posted.",
    "لا يمكن ترحيل الرصيد الافتتاحي المحفوظ لهذا البنك أو تاريخه. صحّحه أولاً. لم يُرحَّل أي شيء.",
  ],
  ServerError_LATE_BANK_OPENING_ALREADY_POSTED: [
    "An opening balance has already been posted for this bank account.",
    "سبق ترحيل رصيد افتتاحي لهذا الحساب البنكي.",
  ],
  ServerError_LATE_BANK_OPENING_NO_ORG_OPENING: [
    "Post the organization's opening balances first. This action only adds a bank created after them.",
    "رحِّل الأرصدة الافتتاحية للمنشأة أولاً. هذا الإجراء مخصص للبنوك التي أُضيفت بعدها.",
  ],
  ServerError_LATE_BANK_OPENING_PERIOD_UNAVAILABLE: [
    "The accounting period for the opening balance date is closed or not open. Nothing was posted.",
    "الفترة المحاسبية لتاريخ الرصيد الافتتاحي مغلقة أو غير مفتوحة. لم يُرحَّل أي شيء.",
  ],
  ServerError_LATE_BANK_OPENING_OWNER_ONLY: [
    "Only an owner can post a bank opening balance.",
    "يستطيع المالك فقط ترحيل الرصيد الافتتاحي لحساب بنكي.",
  ],
  ServerError_LATE_BANK_OPENING_NOT_REVERSIBLE: [
    "A posted bank opening balance cannot be reversed.",
    "لا يمكن عكس الرصيد الافتتاحي المرحَّل لحساب بنكي.",
  ],
  ServerError_LATE_BANK_OPENING_EDIT_REFUSED: [
    "This bank's opening balance has been posted, so its opening balance and date can no longer be changed.",
    "تم ترحيل الرصيد الافتتاحي لهذا البنك، لذا لا يمكن تغيير رصيده الافتتاحي أو تاريخه.",
  ],
  ServerError_LATE_BANK_OPENING_BEFORE_CUTOVER: [
    "This bank's opening balance date is before the organization's opening entry date. Change it to the opening entry date or later. Nothing was posted.",
    "تاريخ الرصيد الافتتاحي لهذا البنك أسبق من تاريخ قيد الافتتاح للمنشأة. غيّره إلى تاريخ قيد الافتتاح أو لاحق. لم يُرحَّل أي شيء.",
  ],
  ServerError_LATE_BANK_OPENING_OPENING_UNPROVABLE: [
    "The organization's opening entry cannot be shown to name every bank it already covers (for example, one of its bank lines names no bank). This bank's opening balance cannot be posted here. Nothing was posted.",
    "لا يمكن إثبات أن قيد الافتتاح للمنشأة يحدد كل البنوك التي يشملها (مثلاً: أحد بنوده البنكية لا يذكر اسم بنك). لا يمكن ترحيل الرصيد الافتتاحي لهذا البنك هنا. لم يُرحَّل أي شيء.",
  ],
  ServerError_LATE_BANK_OPENING_EDIT_UNPROVABLE: [
    "This bank's opening balance and date cannot be changed while the organization's opening entry cannot be shown to name every bank it already covers.",
    "لا يمكن تغيير الرصيد الافتتاحي لهذا البنك أو تاريخه ما دام لا يمكن إثبات أن قيد الافتتاح للمنشأة يحدد كل البنوك التي يشملها.",
  ],
  ServerError_LATE_BANK_OPENING_FIGURES_CHANGED: [
    "The bank's opening figures changed since this screen loaded. Review them and try again. Nothing was posted.",
    "تغيّرت الأرقام الافتتاحية للبنك منذ تحميل هذه الشاشة. راجعها ثم حاول مرة أخرى. لم يُرحَّل أي شيء.",
  ],
  DashboardBankTotal: ["Total bank accounts", "إجمالي الحسابات البنكية"],
  DashboardCashAndBankTotal: ["Total cash and bank accounts", "إجمالي النقد والحسابات البنكية"],
});

export const treasuryEn = messages.en;
export const treasuryAr = messages.ar;
