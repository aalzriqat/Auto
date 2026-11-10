import { defineBilingualMessages } from "../defineBilingualMessages";

const messages = defineBilingualMessages({
  SuppliersStmtAttnPayableTitle: ["Payables needing attention (A/P)", "مستحقات للمورد تحتاج إلى متابعة (A/P)"],
  SuppliersStmtAttnReceivableTitle: ["Receivables needing attention (A/R)", "مستحقات على المورد تحتاج إلى متابعة (A/R)"],
  SuppliersStmtAttnTitle: ["Needs attention", "يحتاج إلى متابعة"],
  SuppliersStmtAttnNone: ["No reminder-eligible or held obligations in this family.", "لا توجد التزامات مؤهلة للتذكير أو موقوفة في هذه الفئة."],
  SuppliersStmtAttnStepT3: ["Due within 3 days", "مستحق خلال 3 أيام"],
  SuppliersStmtAttnStepDue: ["Due-date reminder reached", "حان تذكير تاريخ الاستحقاق"],
  SuppliersStmtAttnStepOverdue7: ["7-day overdue reminder reached", "حان تذكير التأخر 7 أيام"],
  SuppliersStmtAttnStepWeekly: ["Overdue, weekly reminder", "متأخر، تذكير أسبوعي"],
  SuppliersStmtAttnHeldDisputed: ["Held: under dispute, reminders paused", "موقوف: قيد النزاع، التذكيرات معلّقة"],
  SuppliersStmtAttnHeldNoDue: ["Held: no due date, no reminder", "موقوف: لا يوجد تاريخ استحقاق، لا تذكير"],
  SuppliersStmtAttnEligibility: ["Reminder eligibility, not delivery confirmation. Amounts owed to and from this supplier stay separate.", "أهلية التذكير وليست تأكيدًا لإرساله. تبقى المبالغ المستحقة للمورد والمستحقة عليه منفصلة."],
  SuppliersStmtAttnIncomplete: ["Incomplete view: this page is only part of the records. Full counts and totals are unavailable.", "عرض غير مكتمل: هذه الصفحة جزء من السجلات فقط. الأعداد والإجماليات الكاملة غير متاحة."],
  SuppliersStmtAttnBudget: ["Incomplete: the read budget was reached. Figures are unavailable and the page has not advanced. Try again later.", "غير مكتمل: تم بلوغ حد القراءة. الأرقام غير متاحة ولم تتقدم الصفحة. حاول لاحقًا."],
  SuppliersStmtAttnSplit: ["Incomplete: this page needs a smaller read range. Figures are unavailable and the page has not advanced.", "غير مكتمل: تحتاج هذه الصفحة إلى نطاق قراءة أصغر. الأرقام غير متاحة ولم تتقدم الصفحة."],
  SuppliersStmtAttnUnlinked: ["This organisation has unlinked supplier records in this family, including history. They are excluded from this supplier account.", "توجد في هذه المنشأة سجلات موردين غير مرتبطة في هذه الفئة، بما فيها السجلات السابقة. وهي مستبعدة من حساب هذا المورد."],
  SuppliersStmtAttnUnlinkedIncomplete: ["Unlinked-record check incomplete. Their presence and count are unavailable.", "فحص السجلات غير المرتبطة غير مكتمل. وجودها وعددها غير متاحين."],
  SuppliersStmtAttnRestricted: ["Supplier attention is unavailable without finance and cost access.", "متابعة المورد غير متاحة دون صلاحية المالية والاطلاع على التكلفة."],
  SuppliersStmtAttnAsOf: ["As of (Amman)", "كما في (عمّان)"],
  SuppliersStmtAttnRecord: ["Record", "السجل"],
  SuppliersStmtAttnNext: ["Next records", "السجلات التالية"],
  SuppliersStmtAttnPrevious: ["Previous records", "السجلات السابقة"],
  ServerError_SUPPLIER_ATTENTION_UNAVAILABLE: ["Supplier attention could not be loaded. Please try again.", "تعذّر تحميل متابعة المورد. يُرجى المحاولة مرة أخرى."],
});

export const supplierAttentionEn = messages.en;
export const supplierAttentionAr = messages.ar;
