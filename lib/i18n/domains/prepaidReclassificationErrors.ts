import { defineBilingualMessages } from "../defineBilingualMessages";

/** SCRUM-961: refusal texts for the opening-prepaid reclassification codes, kept apart from common.ts under the file-size ratchet. */
const messages = defineBilingualMessages({
  ServerError_PREPAID_RECLASS_LINES: ["List each employee once, with a whole positive amount.", "أدرج كل موظف مرة واحدة مع مبلغ موجب صحيح."],
  ServerError_PREPAID_RECLASS_AMOUNT: ["The total must be less than what is still unrecognized in this prepaid schedule.", "يجب أن يكون الإجمالي أقل من المتبقي غير المعترف به في جدول المصروفات المدفوعة مقدماً."],
  ServerError_PREPAID_RECLASS_REASON: ["Enter a reason of up to 500 characters for moving these amounts to employee advances.", "أدخل سبب نقل هذه المبالغ إلى سلف الموظفين بما لا يتجاوز 500 حرف."],
  ServerError_PREPAID_RECLASS_BENEFICIARY_INVALID: ["Every listed person must be an active member of this organization.", "يجب أن يكون كل شخص في القائمة عضواً فعّالاً في هذه المنشأة."],
  ServerError_PREPAID_RECLASS_BENEFICIARY: ["A person who receives one of these advances cannot request or approve this change.", "لا يجوز لمن يستلم إحدى هذه السلف أن يطلب هذا التغيير أو يعتمده."],
  ServerError_PREPAID_RECLASS_AUTHORITY: ["Finance and payroll management permissions are both required for this change.", "يتطلب هذا التغيير صلاحيتي إدارة المالية والرواتب معاً."],
  ServerError_PREPAID_RECLASS_INELIGIBLE: ["This prepaid schedule cannot be changed. Ask finance to review it.", "لا يمكن تعديل جدول المصروفات المدفوعة مقدماً هذا. اطلب من المسؤول المالي مراجعته."],
  ServerError_PREPAID_RECLASS_PENDING: ["A change request for this schedule is already waiting for a decision.", "يوجد طلب تغيير لهذا الجدول بانتظار القرار."],
  ServerError_PREPAID_RECLASS_ALREADY: ["Amounts were already moved out of this schedule. This change is available once.", "نُقلت مبالغ من هذا الجدول سابقاً. هذا التغيير متاح مرة واحدة."],
  ServerError_PREPAID_RECLASS_SECOND_PERSON: ["A different authorised user must approve this change.", "يجب أن يعتمد هذا التغيير مستخدم مخوّل آخر غير مقدّم الطلب."],
  ServerError_PREPAID_RECLASS_FIGURES: ["The figures changed since you reviewed them. Review the updated figures and try again. Nothing was posted.", "تغيّرت الأرقام منذ مراجعتك. راجع الأرقام المحدّثة وحاول مجدداً. لم يُرحَّل أي شيء."],
  ServerError_PREPAID_RECLASS_STATE: ["This request is no longer waiting for a decision.", "لم يعد هذا الطلب بانتظار القرار."],
  ServerError_PREPAID_RECLASS_PERIOD: ["The accounting period for today is closed or not open. Nothing was posted.", "الفترة المحاسبية لتاريخ اليوم مغلقة أو غير مفتوحة. لم يُرحَّل أي شيء."],
  ServerError_PREPAID_RECLASS_CROSS_PERIOD: ["The recognized months being corrected and today are not in the same open accounting period. Nothing was posted.", "الأشهر المعترف بها المراد تصحيحها وتاريخ اليوم ليست في الفترة المحاسبية المفتوحة نفسها. لم يُرحَّل أي شيء."],
  ServerError_PREPAID_RECLASS_RECOGNITION: ["Monthly recognition for this schedule is still queued, failed or does not match the ledger. Resolve it first. Nothing was posted.", "الاعتراف الشهري لهذا الجدول ما زال في الانتظار أو فشل أو لا يطابق دفتر الأستاذ. عالجه أولاً. لم يُرحَّل أي شيء."],
  ServerError_PREPAID_RECLASS_REVERSAL: ["This change cannot be reversed here. Ask finance to review a correction.", "لا يمكن عكس هذا التغيير من هنا. اطلب من المسؤول المالي مراجعة تصحيح."],
  ServerError_PREPAID_RECLASS_UNAVAILABLE: ["The change could not be completed. Please try again later.", "تعذّر إكمال التغيير. حاول مجدداً لاحقاً."],
});

export const prepaidReclassificationErrorsEn = messages.en;
export const prepaidReclassificationErrorsAr = messages.ar;
