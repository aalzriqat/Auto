import { defineBilingualMessages } from "../defineBilingualMessages";

const messages = defineBilingualMessages({
  CoaTitle: ["Manage chart of accounts", "إدارة دليل الحسابات"],
  CoaDescription: [
    "Create accounts and manage their names and active state.",
    "أنشئ الحسابات وعدّل أسماءها وحالة تفعيلها.",
  ],
  CoaCreate: ["Create account", "إنشاء حساب"],
  CoaEdit: ["Edit account", "تعديل الحساب"],
  CoaCode: ["Account code", "رمز الحساب"],
  CoaNameEn: ["Name (English)", "الاسم بالإنجليزية"],
  CoaNameAr: ["Name (Arabic)", "الاسم بالعربية"],
  CoaName: ["Account name", "اسم الحساب"],
  CoaType: ["Account type", "نوع الحساب"],
  CoaNormalBalance: ["Normal balance", "الرصيد الطبيعي"],
  CoaState: ["State", "الحالة"],
  CoaActions: ["Actions", "الإجراءات"],
  CoaActive: ["Active", "نشط"],
  CoaInactive: ["Inactive", "غير نشط"],
  CoaSystem: ["System account", "حساب نظام"],
  CoaEmpty: [
    "No accounts yet. Initialize the chart or create an account.",
    "لا توجد حسابات بعد. هيّئ دليل الحسابات أو أنشئ حساباً.",
  ],
  CoaReadDenied: [
    "You need permission to view finance to see the chart of accounts.",
    "تحتاج إلى صلاحية عرض الشؤون المالية للاطلاع على دليل الحسابات.",
  ],
  CoaReadOnly: [
    "You can view accounts. Changes require permission to manage finance.",
    "يمكنك عرض الحسابات. يتطلب تعديلها صلاحية إدارة الشؤون المالية.",
  ],
  CoaLoadError: [
    "Accounts could not be loaded. Reload the page and try again.",
    "تعذّر تحميل الحسابات. أعد تحميل الصفحة وحاول مرة أخرى.",
  ],
  CoaSaveError: [
    "The account could not be saved. Please try again.",
    "تعذّر حفظ الحساب. يرجى المحاولة مرة أخرى.",
  ],
  CoaSaved: ["Account saved", "تم حفظ الحساب"],
  CoaSave: ["Save account", "حفظ الحساب"],
  CoaSaving: ["Saving…", "جارٍ الحفظ…"],
  CoaCancel: ["Cancel", "إلغاء"],
  CoaImmutable: [
    "Code, type and normal balance are fixed after creation.",
    "لا يمكن تعديل الرمز والنوع والرصيد الطبيعي بعد إنشاء الحساب.",
  ],
  CoaSystemActive: [
    "System accounts cannot be deactivated.",
    "لا يمكن إلغاء تفعيل حسابات النظام.",
  ],
  CoaType_ASSET: ["Asset", "أصل"],
  CoaType_LIABILITY: ["Liability", "التزام"],
  CoaType_EQUITY: ["Equity", "حقوق الملكية"],
  CoaType_REVENUE: ["Revenue", "إيرادات"],
  CoaType_COGS: ["Cost of goods sold", "تكلفة البضاعة المباعة"],
  CoaType_EXPENSE: ["Expense", "مصروف"],
  CoaType_OTHER_INCOME: ["Other income", "إيرادات أخرى"],
  CoaType_OTHER_EXPENSE: ["Other expense", "مصروفات أخرى"],
  CoaBalance_DEBIT: ["Debit", "مدين"],
  CoaBalance_CREDIT: ["Credit", "دائن"],
  ServerError_ACCOUNT_CODE_EXISTS: [
    "This account code already exists in this organization.",
    "رمز الحساب مستخدم بالفعل في هذه المؤسسة.",
  ],
});

export const chartOfAccountsEn = messages.en;
export const chartOfAccountsAr = messages.ar;
