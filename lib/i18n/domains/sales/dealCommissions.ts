import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * Employee commissions on a deal (SCRUM-783 types, SCRUM-434 net profit). Shown
 * on the deal screen and managed from the Commissions page.
 */
export const dealCommissionMessages = defineBilingualMessages({
  DealCommissionsLabel: ["Commissions", "العمولات"],
  DealCommissionsTotal: ["Total commissions", "إجمالي العمولات"],
  DealCommissionsShow: ["Show breakdown", "عرض التفاصيل"],
  DealCommissionsHide: ["Hide breakdown", "إخفاء التفاصيل"],
  DealCommissionsNone: ["No commissions registered", "لا توجد عمولات مسجلة"],
  DealCommissionsLoading: ["Loading commissions…", "جارٍ تحميل العمولات…"],
  DealCommissionsNetAfter: ["Net profit after commissions", "صافي الربح بعد العمولات"],
  DealCommissionsNetUnavailable: [
    "Net profit after commissions is not available until the profit is known.",
    "صافي الربح بعد العمولات غير متاح قبل معرفة الربح.",
  ],
  DealCommissionsNetPending: [
    "Set the salesperson's commission (0 if none) to see the net profit after commissions.",
    "حدّد عمولة البائع (صفر إن لم تكن هناك عمولة) لعرض صافي الربح بعد العمولات.",
  ],
  ReportNetAfterCommissions: ["Net after commissions", "الصافي بعد العمولات"],
  ReportCommissionsColumn: ["Commissions", "العمولات"],
  ReportCommissionsIncomplete: [
    "sales are left out of the commission totals because their margin or the salesperson's commission is not known.",
    "عمليات بيع مستثناة من إجماليات العمولات لأن هامشها أو عمولة البائع فيها غير معروفة.",
  ],
  DealCommissionsPendingSale: [
    "The salesperson's commission is not decided yet, so this total is incomplete.",
    "عمولة البائع لم تُحدد بعد، لذلك هذا الإجمالي غير مكتمل.",
  ],
  DealCommissionsUnreadable: [
    "A commission amount cannot be read, so the total is not shown.",
    "تعذّرت قراءة مبلغ عمولة، لذلك لا يظهر الإجمالي.",
  ],
  DealCommissionsRegisteredToDate: ["Commissions registered to date", "العمولات المسجلة حتى الآن"],
  CostAmountWithheld: ["This amount requires permission to view vehicle cost.", "عرض هذا المبلغ يتطلب صلاحية عرض تكلفة السيارة."],
  ProfitCommissionsReadBoundExceeded: [
    "The commission lines exceed the readable bound, so net profit is unavailable.",
    "تتجاوز بنود العمولات حد القراءة، لذلك لا يتوفر صافي الربح.",
  ],
  ProfitVehicleCostBasisUnreadable: [
    "The vehicle's cost basis cannot be read completely in the deal currency, so net profit is unavailable.",
    "تعذّرت قراءة أساس تكلفة السيارة بالكامل بعملة الصفقة، لذلك لا يتوفر صافي الربح.",
  ],
  DealCommissionsRegisteredNote: [
    "Registered amounts. Each is recorded in the books when added and paid with the employee's salary.",
    "مبالغ مسجلة. يُسجَّل كل مبلغ في الدفاتر عند إضافته ويُدفع مع راتب الموظف.",
  ],
  DealCommissionsOpenPage: ["Manage on the Commissions page", "إدارة العمولات من صفحة العمولات"],
  DealCommissionKindSALE: ["Sale commission", "عمولة بيع"],
  DealCommissionKindPURCHASE: ["Purchase commission", "عمولة شراء"],
  DealCommissionKindEXECUTION: ["Execution commission", "عمولة تنفيذ"],
  DealCommissionKindHintSALE: ["The employee who sold the car", "الموظف الذي باع السيارة"],
  DealCommissionKindHintPURCHASE: ["The employee who brought the car in", "الموظف الذي جلب السيارة"],
  DealCommissionKindHintEXECUTION: ["The employee who executed the financing", "الموظف الذي نفّذ معاملة التمويل"],
  DealCommissionSalespersonLine: ["Salesperson's commission", "عمولة البائع"],
  DealCommissionLinesAction: ["Lines", "البنود"],
  DealCommissionLinesTitle: ["Commission lines", "بنود العمولات"],
  DealCommissionLinesAdd: ["Add commission line", "إضافة بند عمولة"],
  DealCommissionLinesType: ["Type", "النوع"],
  DealCommissionLinesEmployee: ["Employee", "الموظف"],
  DealCommissionLinesAmount: ["Amount", "المبلغ"],
  DealCommissionLinesNote: ["Note (optional)", "ملاحظة (اختياري)"],
  DealCommissionLinesRemove: ["Remove", "إزالة"],
  DealCommissionLinesSave: ["Add line", "إضافة البند"],
  DealCommissionLinesSalesPersonHint: [
    "The salesperson's own commission is set with the amount on the main row. Add other people's commissions here.",
    "عمولة البائع نفسه تُحدد بالمبلغ في الصف الرئيسي. أضف هنا عمولات الآخرين.",
  ],
  DealCommissionLinesPilotPaused: [
    "Adding commission lines is not available during the pilot. The salesperson's commission still counts.",
    "إضافة بنود العمولات غير متاحة خلال المرحلة التجريبية. عمولة البائع ما زالت محتسبة.",
  ],
  DealCommissionLinesAdded: ["Commission line added", "تمت إضافة بند العمولة"],
  DealCommissionLinesRemoved: ["Commission line removed", "تمت إزالة بند العمولة"],
});
