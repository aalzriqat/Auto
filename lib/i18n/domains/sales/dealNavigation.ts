import { defineBilingualMessages } from "../../defineBilingualMessages";

export const dealNavigationMessages = defineBilingualMessages({
  /** The Deals list — one entry per deal, the needs-action queue first. */
  DealsTitle: ["Deals", "الصفقات"],
  NewDeal: ["New deal", "صفقة جديدة"],
  DealsNeedsAction: ["Needs action", "تحتاج إجراءً"],
  DealsWaitingOnOthers: ["Waiting on others", "بانتظار أطراف أخرى"],
  DealsAll: ["All deals", "كل الصفقات"],
  DealKindCash: ["Cash", "نقدي"],
  DealKindFinanced: ["Financed", "مموَّل"],
  SearchDeals: ["Search deals by customer, vehicle, financier or owner", "ابحث في الصفقات بالعميل أو السيارة أو جهة التمويل أو المسؤول"],
  LoadingDeals: ["Loading deals…", "جارٍ تحميل الصفقات…"],
  NoDealsFound: ["No deals match these filters.", "لا توجد صفقات مطابقة لهذه التصفية."],
  DealsQueueEmpty: ["Nothing is waiting on the dealership right now.", "لا شيء بانتظار المعرض حاليًا."],
  DealsQueueEmptyLoadedOnly: [
    "Nothing on the loaded deals is waiting on the dealership. Older deals are not loaded yet and may still need action — load more to check them.",
    "لا شيء في الصفقات المحمّلة بانتظار المعرض. الصفقات الأقدم لم تُحمَّل بعد وقد تحتاج إجراءً — حمّل المزيد للتحقق منها.",
  ],
  DealsReasonColumn: ["Waiting on", "بانتظار"],
  DealsCustomerVehicleColumn: ["Customer · vehicle", "العميل · السيارة"],
  DealsTypeColumn: ["Type · financier", "النوع · جهة التمويل"],
  DealsSinceColumn: ["Since", "منذ"],
  /** The Deals list's rich rows: the car, the customer, the financing, the live step and the two figures. */
  DealsCarColumn: ["Car", "السيارة"],
  DealsCustomerColumn: ["Customer", "العميل"],
  DealsFinancingColumn: ["Financing", "التمويل"],
  DealsStepColumn: ["Current step", "الخطوة الحالية"],
  DealsSellingPriceColumn: ["Selling price", "سعر البيع"],
  DealsNetProfitColumn: ["Net profit", "صافي الربح"],
  DealsConsignedTag: ["Consignment", "أمانة"],
  DealsStepDone: ["All steps done", "اكتملت كل الخطوات"],
  DealsFigureNeedsCostAccess: ["Needs cost access", "يتطلب صلاحية التكلفة"],
  DealsFigureNeedsFinanceAccess: ["Needs finance access", "يتطلب صلاحية المالية"],
  DealsFigureNotCalculable: ["Not calculable yet", "غير قابل للحساب بعد"],
  DealsFigureLoading: ["Loading", "جارٍ التحميل"],
  DealsRowDetailsUnavailable: ["Deal details unavailable", "تفاصيل الصفقة غير متاحة"],
  OpenDealRow: ["Open deal", "فتح الصفقة"],
  DealsShownOf: ["shown of", "معروضة من"],
  DealsLoadedMoreAvailable: ["loaded — more can be loaded; counts are of loaded rows", "محمّلة — يمكن تحميل المزيد؛ الأعداد للصفوف المحمّلة فقط"],
  DealsLoadedAll: ["loaded — that is every deal", "محمّلة — وهذه كل الصفقات"],
  ReasonDepositPending: ["Held deposit to resolve", "عربون محتجز بحاجة لحسم"],
  ReasonDocsPending: ["Documents to complete", "مستندات ناقصة"],
  ReasonAwaitingDecision: ["Financier decision", "قرار جهة التمويل"],
  ReasonReadyForHandover: ["Handover and close", "التسليم والإغلاق"],
  ReasonAwaitingReceipt: ["Financier payment to the dealership", "دفعة جهة التمويل للمعرض"],
  ReasonCashPending: ["Cash sale to complete", "بيع نقدي لإتمامه"],
  ReasonSalePending: ["Sale to complete", "بيع لإتمامه"],
  /** The two panes under the money on the Deal. */
  DealTabDocuments: ["Documents", "المستندات"],
  DealTabActivity: ["Activity", "السجل"],
  /** Under the outstanding documents on the live step: the way to where they are uploaded. */
  GoToDocuments: ["Go to documents", "الانتقال إلى المستندات"],
  /** The status history before the deal has recorded any transition. */
  StatusLogEmpty: ["No status changes recorded yet.", "لم تُسجَّل أي تغييرات على الحالة بعد."],

  /** The compact deal header, stage rail and six-fact money summary. */
  BackToDeals: ["Deals", "الصفقات"],
  /** "Step 3 of 8" — the numbers are rendered beside it as their own isolated runs. One word, "step", on every surface that counts (SCRUM-417 UX5). */
  StageOfLabel: ["Step", "الخطوة"],
  /** "Step 7 of 8": a sentence, not "7 / 8", so Arabic reads 7 before 8 (SCRUM-468). */
  StageOfSeparator: ["of", "من"],
  /** The compact mobile header: "Step 3 of 8 · Handover" (SCRUM-417 UX5, O4). */
  MobileStepLabel: ["Step", "الخطوة"],
  /** Appended to the phone bar while a step other than the live one is being looked at. */
  MobileStepViewing: ["Viewing", "قيد العرض"],
  ShowAllSteps: ["Show all steps", "عرض كل الخطوات"],
  HideAllSteps: ["Hide steps", "إخفاء الخطوات"],
  /** The persistent line after a step is saved and the screen shows it (S7). */
  RecordedLead: ["Recorded.", "تم التسجيل."],
  RecordedNextPrefix: ["Next:", "التالي:"],
  RecordedAllDone: ["Nothing left to do on this deal.", "لا يوجد ما تبقى للقيام به في هذه الصفقة."],
  DismissRecorded: ["Dismiss", "إغلاق"],
  DealAllStagesComplete: ["All stages complete", "اكتملت جميع المراحل"],
  /** Every stage is finished but at least one was not needed: no "complete" claim. */
  DealStagesFinished: ["All stages finished", "انتهت جميع المراحل"],
  DealStagesCompleteCount: ["complete", "مكتملة"],
  DealStagesNotNeededCount: ["not needed", "غير مطلوبة"],
  ShowStages: ["Show stages", "عرض المراحل"],
  HideStages: ["Hide stages", "إخفاء المراحل"],
  FinancialSummaryHeading: ["Financial summary", "الملخص المالي"],
  FactCustomer: ["Customer", "العميل"],
  FactFinancier: ["Finance company", "شركة التمويل"],
  FactSupplier: ["Supplier", "المورد"],
  /** Read to assistive technology on every rail node; colour alone is not state. */
  StageStateComplete: ["Complete", "مكتملة"],
  StageStateCurrent: ["Current stage", "المرحلة الحالية"],
  StageStateBlocked: ["Blocked", "متوقفة"],
  StageStatePending: ["Not started", "لم تبدأ"],
  StageStateStopped: ["Will not continue", "لن تستكمل"],
  StageStateNotApplicable: ["Not needed", "غير مطلوبة"],
  ProfitBreakdownToggle: ["How this is calculated", "طريقة الاحتساب"],
  /** The headline is served but its working is not — distinct from "never recorded". */
  ProfitBreakdownUnavailable: ["Breakdown unavailable", "التفصيل غير متاح"],
  DealEssentialsHeading: ["Deal essentials", "أساسيات الصفقة"],
});
