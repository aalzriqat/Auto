import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * SCRUM-417 UX PR 4: the sub-steps inside a stage (O2) and the clickable rail's
 * past / future step views (O3). Defined once per message, like the rail's own.
 */
export const dealStepMessages = defineBilingualMessages({
  ChecklistHeading: ["Steps in this stage", "خطوات هذه المرحلة"],
  ChecklistDone: ["Done", "تم"],
  ChecklistCurrent: ["Next", "التالي"],
  ChecklistPending: ["Not yet", "لاحقًا"],
  ChecklistApprovedAmountRecorded: ["Approved amount recorded", "تسجيل المبلغ المعتمد"],
  ChecklistShortfallSettled: ["Shortfall settled", "تسوية الفرق"],
  ChecklistDocumentsUploaded: ["Required documents uploaded", "رفع المستندات المطلوبة"],
  ChecklistDocumentsVerified: ["Required documents verified", "التحقق من المستندات المطلوبة"],
  ChecklistCostsRecorded: ["Handover costs recorded", "تسجيل تكاليف التسليم"],
  ChecklistCostsPaid: ["Handover costs paid", "دفع تكاليف التسليم"],
  ChecklistDealFiguresReady: ["Deal figures ready to hand over", "أرقام الصفقة جاهزة للتسليم"],
  ChecklistRegisterHandover: ["Register the handover", "تسجيل تسليم المركبة"],
  ChecklistRouteRecorded: ["Settlement route recorded", "تسجيل مسار التسوية"],
  ChecklistClosingChecksReady: ["Closing checks ready", "جاهزية فحوصات الإغلاق"],
  ChecklistCloseDeal: ["Close the deal", "إغلاق الصفقة"],
  ChecklistExpectedPaymentRegistered: ["Expected payment registered", "الدفعة المتوقعة مسجّلة"],
  ChecklistDepositResolved: ["Held deposit resolved", "معالجة العربون المحتجز"],
  ChecklistCurrencySupported: ["Deal currency supported for closing", "عملة الصفقة مدعومة للإغلاق"],
  ChecklistReconciliationResolved: ["Reconciliation note reviewed", "مراجعة ملاحظة التسوية"],
  ChecklistCashDepositDecision: ["Deposit decision made", "اتخاذ قرار العربون"],
  ChecklistCompleteSale: ["Complete the sale", "إتمام البيع"],
  ChecklistHandoverRegistered: ["Vehicle handover registered", "تسجيل تسليم المركبة"],
  ChecklistSaleClosed: ["Sale closed", "إغلاق البيع"],
  ChecklistPaymentConfirmed: ["Finance company payment confirmed", "تأكيد صرف شركة التمويل"],

  BackToCurrentStep: ["Back to current step", "العودة إلى الخطوة الحالية"],
  StageViewBack: ["Close this view", "إغلاق هذا العرض"],
  StageViewing: ["viewing", "قيد العرض"],
  StageViewPastNote: [
    "You are looking at a step that is already done. This is a read-only view of what was recorded.",
    "أنت تعرض خطوة منتهية. هذا عرض للقراءة فقط لما تم تسجيله.",
  ],
  StageViewFutureNote: [
    "You are looking at a step that has not started. Nothing here can be done yet.",
    "أنت تعرض خطوة لم تبدأ بعد. لا يمكن تنفيذ شيء هنا الآن.",
  ],
  StageViewStoppedNote: [
    "This step stopped when the deal was rejected or cancelled. Nothing more will happen here.",
    "توقفت هذه الخطوة عند رفض الصفقة أو إلغائها. لن يحدث شيء آخر هنا.",
  ],
  // SCRUM-446: a step the server proved is not needed on this deal.
  StageViewNotApplicableNote: [
    "This step is not needed on this deal.",
    "هذه الخطوة غير مطلوبة في هذه الصفقة.",
  ],
  StageNotApplicableReasonDisbursement: [
    "No finance company pays the dealership on this deal.",
    "لا توجد شركة تمويل تدفع للمعرض في هذه الصفقة.",
  ],
  StageNotApplicableReasonDeliveryActions: [
    "No documents are required on this deal.",
    "لا توجد مستندات مطلوبة في هذه الصفقة.",
  ],
  StageViewAnnounceShowing: ["Showing step", "عرض الخطوة"],
  StageViewAnnounceBack: ["Back to the current step", "العودة إلى الخطوة الحالية"],
  // ROUND 2 (SCRUM-417 UX4): the deal is closed and this step waits on the finance company.
  StageViewAnnounceBackDone: ["Back to the deal summary", "العودة إلى ملخص الصفقة"],
  StageViewSettlementClosedNote: [
    "The deal is closed. This step completes when the finance company's payment is confirmed, and the supplier is settled where the vehicle was supplied on consignment.",
    "الصفقة مغلقة. تكتمل هذه الخطوة عند تأكيد دفعة شركة التمويل، وعند تسوية المورّد إن كانت المركبة مورَّدة بالأمانة.",
  ],
  // A deposit request still waiting blocks the close (finalizeDeal refuses on it first).
  ChecklistDepositRequestResolved: ["Deposit request resolved", "معالجة طلب العربون"],
  FinalizeNeedsPendingDepositRequestResolved: [
    "A deposit request on this deal is waiting for a manager or accountant to confirm receipt or reject it. The deal can't be closed until it is resolved.",
    "طلب عربون على هذه الصفقة بانتظار أن يؤكّد مدير أو محاسب استلامه أو يرفضه. لا يمكن إغلاق الصفقة قبل معالجته.",
  ],
  StageViewNeedsHeading: ["What it will need", "ما تحتاجه"],
  StageViewWhoActs: ["Who acts", "الجهة المنفّذة"],
  StageViewShowRecord: ["Show the recorded details", "عرض التفاصيل المسجّلة"],
  CorrectRecordedLegalInvoiceAction: ["Correct the recorded legal invoice", "تصحيح الفاتورة القانونية المسجّلة"],
  CorrectSubmittedQuotationAction: ["Correct the submitted quotation", "تصحيح عرض السعر المُرسَل"],
  ReopenForQuotationAction: ["Withdraw approval and correct quotation", "سحب الاعتماد وتصحيح عرض السعر"],
  ReopenForQuotationImpact: [
    "This withdraws the current approval. Record the corrected quotation, then record a new approval before handover.",
    "يؤدي هذا إلى سحب الاعتماد الحالي. سجّل عرض السعر المصحّح ثم سجّل اعتمادًا جديدًا قبل التسليم.",
  ],
  ServerError_APPROVAL_CORRECTION_STALE: [
    "The approval changed while you were editing. Close this form and review the latest approval before trying again.",
    "تغيّر الاعتماد أثناء التعديل. أغلق النموذج وراجع أحدث اعتماد قبل المحاولة مرة أخرى.",
  ],
  ServerError_DEAL_CORRECTION_STALE: [
    "The deal changed while you were editing. Close this form and review the latest details before trying again.",
    "تغيّرت الصفقة أثناء التعديل. أغلق النموذج وراجع أحدث التفاصيل قبل المحاولة مرة أخرى.",
  ],
  CorrectCashDraftTermsAction: ["Correct cash sale terms", "تصحيح تفاصيل البيع النقدي"],
  CorrectCashDraftTermsImpact: [
    "These terms will be used when the sale is completed. The draft stays open.",
    "سيتم استخدام هذه التفاصيل عند إتمام البيع. تظل المسودة مفتوحة.",
  ],
  CashDraftRecordedPrice: ["Recorded price", "السعر المسجّل"],
  CashDraftReplacementBuyer: ["Replacement buyer", "العميل البديل"],
  CashDraftReplacementVehicle: ["Replacement vehicle", "المركبة البديلة"],
  CashDraftKeepBuyer: ["Keep current buyer", "الإبقاء على العميل الحالي"],
  CashDraftKeepVehicle: ["Keep current vehicle", "الإبقاء على المركبة الحالية"],
  CashDraftCorrectionFailed: ["The draft could not be saved. Check the terms and try again.", "تعذّر حفظ المسودة. راجع التفاصيل وحاول مرة أخرى."],
  ServerError_CASH_DRAFT_CORRECTION_STALE: [
    "The draft changed while you were editing. Close this form and review the latest terms before trying again.",
    "تغيّرت المسودة أثناء التعديل. أغلق النموذج وراجع أحدث التفاصيل قبل المحاولة مرة أخرى.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_HAS_ACCOUNTING: [
    "This sale already has accounting history. Ask an accountant to review the correction.",
    "لهذا البيع سجلات محاسبية. اطلب من المحاسب مراجعة التصحيح.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_LINKED_REFERENCE: [
    "Review the linked lead, trade-in or down payment before changing the buyer or vehicle.",
    "راجع العميل المحتمل أو مركبة البدل أو الدفعة الأولى المرتبطة قبل تغيير العميل أو المركبة.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_BUYER_INACTIVE: [
    "Choose an active buyer in this dealership.",
    "اختر عميلاً نشطاً في هذا المعرض.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_VEHICLE_UNAVAILABLE: [
    "Choose an available replacement vehicle.",
    "اختر مركبة بديلة متاحة.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_VEHICLE_BRANCH: [
    "Verify the draft’s branch and use a vehicle with the original ownership type.",
    "تحقّق من فرع المسودة واختر مركبة من نوع الملكية الأصلي.",
  ],
  ServerError_CASH_DRAFT_CORRECTION_DEPOSIT_REVIEW: [
    "Review the deposit on the original vehicle before changing the buyer or vehicle.",
    "راجع العربون المرتبط بالمركبة الأصلية قبل تغيير العميل أو المركبة.",
  ],
  StageNeedsApplication: [
    "The application put together and sent to the finance company.",
    "تجهيز الطلب وإرساله إلى شركة التمويل.",
  ],
  StageNeedsCreditDecision: [
    "The finance company's credit decision, recorded here.",
    "قرار شركة التمويل الائتماني، مسجّلًا هنا.",
  ],
  StageNeedsAppraisal: [
    "A valuation of the vehicle, from the finance company or an independent appraiser.",
    "تقييم للمركبة من شركة التمويل أو من مقيّم مستقل.",
  ],
  StageNeedsApprovedPurchase: [
    "The amount the finance company approves for the purchase, and any shortfall settled.",
    "المبلغ الذي توافق عليه شركة التمويل للشراء، وتسوية أي فرق.",
  ],
  StageNeedsDeliveryActions: [
    "Every required document uploaded and verified.",
    "رفع جميع المستندات المطلوبة والتحقق منها.",
  ],
  StageNeedsDisbursement: [
    "The finance company's payment, confirmed once the sale is handed over and closed.",
    "صرف شركة التمويل، ويُؤكَّد بعد تسليم المركبة وإغلاق البيع.",
  ],
  StageNeedsHandover: [
    "The deal figures ready, then the vehicle handover registered. Handover costs are settled later, before the deal is closed.",
    "جاهزية أرقام الصفقة، ثم تسجيل تسليم المركبة. تُسوّى تكاليف التسليم لاحقًا، قبل إغلاق الصفقة.",
  ],
  StageNeedsHandoverCash: [
    "The draft sale completed, with the deposit decision made where a deposit was received.",
    "إتمام البيع المسودّة، مع اتخاذ قرار العربون إن كان قد استُلم عربون.",
  ],
  StageNeedsSettlement: [
    "The expected payment registered, a settlement route where one is required, the handover costs recorded and paid and the closing checks ready, then the deal closed.",
    "تسجيل الدفعة المتوقعة، ومسار التسوية إن كان مطلوبًا، وتسجيل تكاليف التسليم ودفعها، وجاهزية فحوصات الإغلاق، ثم إغلاق الصفقة.",
  ],
  StageNeedsSettlementCash: [
    "The supplier's claim settled, where the vehicle was supplied on consignment.",
    "تسوية مطالبة المورّد، إن كانت المركبة مورَّدة بالأمانة.",
  ],
  StageNeedsSaleAgreed: ["The sale agreed with the customer.", "الاتفاق على البيع مع العميل."],
});
