import { defineBilingualMessages } from "../defineBilingualMessages";

/**
 * SCRUM-961: moving part of an opening prepaid schedule into per-person employee advances. Refusal texts live with the
 * other `ServerError_PREPAID_RECLASS_*` codes in common.ts; these are the screen's own words.
 */
const messages = defineBilingualMessages({
  PrepaidReclassAction: ["Reclassify part to employee advances", "إعادة تصنيف جزء إلى سلف الموظفين"],
  PrepaidReclassHelp: [
    "Use this when part of this opening prepaid amount was money advanced to employees. Each person gets an employee advance that payroll can recover. Cash and bank balances do not change.",
    "استخدم هذا الإجراء عندما يكون جزء من هذا المبلغ المدفوع مقدماً الافتتاحي سلفاً صُرفت للموظفين. يحصل كل شخص على سلفة موظف يمكن استردادها من الرواتب. لا تتغير أرصدة النقد والبنوك.",
  ],
  PrepaidReclassEmployeeN: ["Employee {n}", "الموظف {n}"],
  PrepaidReclassAmountN: ["Amount for employee {n}", "مبلغ الموظف {n}"],
  PrepaidReclassSelectEmployee: ["Select employee", "اختر الموظف"],
  PrepaidReclassAddLine: ["Add another employee", "إضافة موظف آخر"],
  PrepaidReclassRemoveLineN: ["Remove employee {n}", "إزالة الموظف {n}"],
  PrepaidReclassReason: ["Reason", "السبب"],
  PrepaidReclassReasonHint: [
    "Explain why these amounts are employee advances (up to 500 characters).",
    "اشرح سبب اعتبار هذه المبالغ سلفاً للموظفين (حتى 500 حرف).",
  ],
  PrepaidReclassReasonRequired: ["Enter a reason.", "أدخل السبب."],
  PrepaidReclassLinesRequired: [
    "Choose each employee once and enter an amount above zero, with no more decimal places than the currency allows.",
    "اختر كل موظف مرة واحدة وأدخل مبلغاً أكبر من صفر، دون تجاوز عدد المنازل العشرية للعملة.",
  ],
  PrepaidReclassMembersLoading: ["Loading team members…", "جارٍ تحميل أعضاء الفريق…"],
  PrepaidReclassNoMemberAccess: [
    "You need permission to view team members before you can choose employees.",
    "تحتاج إلى صلاحية عرض أعضاء الفريق قبل اختيار الموظفين.",
  ],
  PrepaidReclassPreviewTitle: ["What will happen", "ما الذي سيحدث"],
  PrepaidReclassPreviewEmpty: [
    "Choose the employees and amounts to see what will happen.",
    "اختر الموظفين والمبالغ لترى ما الذي سيحدث.",
  ],
  PrepaidReclassPreviewLoading: ["Working out the figures…", "جارٍ احتساب الأرقام…"],
  PrepaidReclassMoved: ["Moved out of prepaid expenses into employee advances", "يُنقل من المصروفات المدفوعة مقدماً إلى سلف الموظفين"],
  PrepaidReclassTrueUp: ["Expense already recognised that is given back", "مصروف محتسب سابقاً يُعاد"],
  PrepaidReclassNewTotal: ["New schedule total", "إجمالي الجدول الجديد"],
  PrepaidReclassNewRecognized: ["Recognised to date after the change", "المحتسب حتى تاريخه بعد التغيير"],
  PrepaidReclassMonthsLeft: ["Months still to recognise", "الأشهر المتبقية للاحتساب"],
  PrepaidReclassNoCash: [
    "Cash and bank balances do not change. Nothing is posted until a second authorised person approves.",
    "لا تتغير أرصدة النقد والبنوك. لا يُرحَّل شيء حتى يعتمده شخص مخوّل آخر.",
  ],
  PrepaidReclassSubmit: ["Request approval", "طلب الاعتماد"],
  PrepaidReclassRequested: [
    "Request sent. A second authorised person must approve it.",
    "أُرسل الطلب. يجب أن يعتمده شخص مخوّل آخر.",
  ],
  PrepaidReclassPendingNotice: [
    "Waiting for approval: {amount} to move to employee advances.",
    "بانتظار الاعتماد: نقل {amount} إلى سلف الموظفين.",
  ],
  PrepaidReclassReview: ["Review request", "مراجعة الطلب"],
  PrepaidReclassReviewTitle: ["Review moving amounts to employee advances", "مراجعة نقل مبالغ إلى سلف الموظفين"],
  PrepaidReclassRequestedByYou: [
    "You requested this change. A different authorised person must approve it.",
    "أنت من طلب هذا التغيير. يجب أن يعتمده شخص مخوّل آخر.",
  ],
  PrepaidReclassRequestedByOther: ["Requested by another team member.", "طلبه عضو آخر في الفريق."],
  PrepaidReclassTotal: ["Total moved", "إجمالي المبلغ المنقول"],
  PrepaidReclassFiguresUnavailable: [
    "The figures for this request cannot be confirmed now, so it cannot be approved. Dismiss it or try again later.",
    "تعذّر تأكيد أرقام هذا الطلب الآن، لذا لا يمكن اعتماده. ألغِه أو حاول لاحقاً.",
  ],
  PrepaidReclassApproveNote: [
    "Approving posts exactly the figures shown. If they have changed, nothing is posted and you are shown the new figures.",
    "يرحّل الاعتماد الأرقام المعروضة نفسها. إذا تغيّرت فلن يُرحَّل شيء وستظهر لك الأرقام الجديدة.",
  ],
  PrepaidReclassApprove: ["Approve and post", "اعتماد وترحيل"],
  PrepaidReclassDismiss: ["Dismiss request", "إلغاء الطلب"],
  PrepaidReclassApproved: ["Posted. The amounts are now employee advances.", "تم الترحيل. أصبحت المبالغ سلفاً للموظفين."],
  PrepaidReclassDismissed: ["Request dismissed.", "أُلغي الطلب."],
  PrepaidReclassApprovedSummary: ["{amount} moved to employee advances", "نُقل {amount} إلى سلف الموظفين"],
  PrepaidReclassApprovedTrueUp: ["{amount} of recognised expense given back", "أُعيد {amount} من المصروف المحتسب"],
  PrepaidReclassApprovedOn: ["Posted on {date}", "رُحّل بتاريخ {date}"],
  PrepaidReclassViewAdvances: ["View employee advances", "عرض سلف الموظفين"],
  PrepaidReclassStatusLoading: ["Checking employee advance options…", "جارٍ التحقق من خيارات سلف الموظفين…"],
  PrepaidReclassStatusUnavailable: [
    "Employee advance options are unavailable right now.",
    "خيارات سلف الموظفين غير متاحة حالياً.",
  ],
  PrepaidReclassUnknownMember: ["Team member", "عضو في الفريق"],
  AdvanceFromPrepaidReclass: ["From opening prepaid", "من المدفوع مقدماً الافتتاحي"],
});

export const prepaidReclassificationEn = messages.en;
export const prepaidReclassificationAr = messages.ar;
