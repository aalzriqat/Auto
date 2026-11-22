import { defineBilingualMessages } from "../defineBilingualMessages";

export const financeCockpitLegacyRefusals = defineBilingualMessages({
  FinanceDealReconciliationNeedsNote: [
    "Record what was checked before clearing the reconciliation flag.",
    "سجّل ما راجعته قبل إزالة وسم التسوية.",
  ],
  FinanceDealReconciliationAlreadyCleared: [
    "This deal is not flagged for reconciliation.",
    "هذه الصفقة غير موسومة للمراجعة. حدّث بيانات الصفقة للاطلاع على حالتها الحالية.",
  ],
  FinanceFeeReconciliationVoided: [
    "This cost has been voided and cannot be reconciled.",
    "أُلغي هذا المصروف ولا يمكن تسويته.",
  ],
  FinanceFeeReconciliationNeedsActual: [
    "Record what this cost actually came to before reconciling it. An estimate is not evidence.",
    "سجّل المبلغ الفعلي للمصروف قبل تسويته. التقدير لا يكفي لإثبات المبلغ.",
  ],
  FinanceFeeReconciliationAmountChanged: [
    "The recorded amount of this cost has changed since you opened it, so your check no longer describes it. Reload the deal and check the current figure. Nothing has been changed.",
    "تغيّر المبلغ المسجّل لهذا المصروف منذ فتحه. أعد تحميل الصفقة وتحقّق من المبلغ الحالي. لم يُحفظ أي تغيير.",
  ],
  FinanceFeeReconciliationEvidenceChanged: [
    "The receipt, paid date or attachments of this cost have been re-recorded since you opened it, so your check no longer describes them. Reload the deal and check the current evidence. Nothing has been changed.",
    "أُعيد تسجيل وصل هذا المصروف أو تاريخ الدفع أو مرفقاته منذ فتحه. أعد تحميل الصفقة وتحقّق من المستندات الحالية. لم يُحفظ أي تغيير.",
  ],
  FinanceFeeReconciliationDuplicate: [
    "This cost has already been reconciled. Re-record its amount if the figure is wrong; that withdraws the reconciliation.",
    "سُوّي هذا المصروف بالفعل. إذا كان المبلغ خاطئًا، فأعد تسجيله لإلغاء التسوية السابقة.",
  ],
  FinanceFeeReconciliationNeedsDifferentReviewer: [
    "Reconciling a cost charged to a custody record has to be done by somebody other than the person holding the cash.",
    "يجب أن يسوّي المصروف المحمّل على العهدة شخص غير حامل النقد.",
  ],
  FinanceFeeNotFound: [
    "Deal cost not found in this organization.",
    "تعذّر العثور على مصروف الصفقة في هذه المؤسسة.",
  ],
  FinanceSettlementRoutePosted: [
    "This deal is already finalized and its settlement has posted, so the route cannot be changed. Correct the sale instead.",
    "أُغلقت هذه الصفقة ورُحّلت تسويتها. صحّح سجل البيع لتعديلها.",
  ],
  FinanceSettlementRouteActiveCheque: [
    "This deal has a live finance-company cheque to the dealership, which contradicts the direct route. Correct the expected payment first.",
    "يوجد شيك قائم من شركة التمويل لصالح المعرض، وهذا يتعارض مع الدفع المباشر للمورد. صحّح الدفعة المتوقعة أولًا.",
  ],
  FinanceSettlementRouteNoOutsidePayer: [
    "This deal has no outside financier, so nobody outside the dealership pays the supplier — the direct route does not apply. If the dealership is financing the customer itself, settle through the dealership.",
    "لا يوجد ممول خارجي يسدّد للمورد في هذه الصفقة، لذا لا ينطبق مسار الدفع المباشر. إذا كان المعرض يمول العميل، فأجرِ التسوية عبر المعرض.",
  ],
  FinanceSettlementRouteCancelled: [
    "This application was cancelled.",
    "أُلغي هذا الطلب.",
  ],
  FinanceSettlementRouteOwnedStock: [
    "This vehicle is dealership stock, so there is no supplier to settle with and no settlement route to choose.",
    "هذه السيارة من مخزون المعرض، فلا يوجد مورد لتسويته ولا مسار تسوية لاختياره.",
  ],
  FinanceSettlementRouteUnnamedLeaseProvider: [
    "This is a lease, and the leasing provider is not recorded anywhere on the deal — so a payment to the supplier could not be attributed to anyone. Settle through the dealership until the provider is recorded.",
    "هذه صفقة تأجير، ولم تُسجّل فيها جهة التأجير التي ستدفع للمورد. أجرِ التسوية عبر المعرض إلى أن تُسجّل الجهة.",
  ],
  FinanceSettlementRouteUnnamedProvider: [
    "The finance provider on this deal is not named, so a payment to the supplier could not be attributed to anyone. Record the provider on the quote, then choose this route.",
    "جهة التمويل التي ستدفع للمورد غير مسمّاة في هذه الصفقة. سجّل الجهة في عرض السعر، ثم اختر هذا المسار.",
  ],
  FinanceSettlementAdviceAmountPositive: [
    "Disbursement amount must be positive.",
    "يجب أن يكون مبلغ الصرف أكبر من صفر.",
  ],
  FinanceSettlementAdviceNeedsReason: [
    "Say why the recorded advice was wrong. This amendment changes evidence about a payment somebody else made, and the reason is the only account of it.",
    "اذكر سبب الخطأ في الإشعار المسجّل. يعدّل هذا الإجراء مستندًا يتعلق بدفعة سدّدها طرف آخر، ويُوثّق السبب أساس التعديل.",
  ],
  FinanceSettlementAdviceInvalidDate: [
    "That disbursement date is not a valid date.",
    "تاريخ الصرف غير صالح.",
  ],
  FinanceSettlementAdviceFutureDate: [
    "The disbursement date cannot be in the future.",
    "لا يمكن أن يكون تاريخ الصرف في المستقبل.",
  ],
  FinanceSettlementAdviceMissing: [
    "There is no recorded settlement advice on this deal to amend. Record what the company paid the supplier first.",
    "لا يوجد إشعار تسوية مسجّل لهذه الصفقة لتعديله. سجّل أولًا ما دفعته شركة التمويل للمورد.",
  ],
  FinanceSettlementAdviceNeedsApprovedAmount: [
    "This deal has no approved purchase amount recorded, so there is nothing to check the corrected advice against.",
    "لا يوجد مبلغ شراء معتمد مسجّل لهذه الصفقة. سجّل المبلغ المعتمد قبل مراجعة الإشعار المصحّح.",
  ],
});

const settlementAdviceRecovery = defineBilingualMessages({
  FinanceSettlementAdviceApplicationUnavailable: [
    "This deal is no longer available here. Refresh the deal list before trying again.",
    "لم تعد هذه الصفقة متاحة هنا. حدّث قائمة الصفقات قبل المحاولة مجددًا.",
  ],
  FinanceSettlementAdviceReviewRecorded: [
    "We couldn’t match this correction to the earlier submission. Reload the deal and review the recorded advice before submitting another correction.",
    "تعذّر مطابقة هذا التصحيح مع الطلب السابق. أعد تحميل الصفقة وراجع الإشعار المسجّل قبل إرسال تصحيح آخر.",
  ],
  FinanceSettlementAdviceInProgress: [
    "A correction is still being processed. Wait briefly, then retry with the same details.",
    "لا يزال التصحيح قيد المعالجة. انتظر قليلًا ثم أعد المحاولة بالبيانات نفسها.",
  ],
  FinanceSettlementAdviceAmountInvalid: [
    "Enter a positive disbursement amount within the supported range and use the decimal places supported by the deal’s currency.",
    "أدخل مبلغ صرف أكبر من صفر وضمن النطاق المدعوم، وبعدد المنازل العشرية الذي تدعمه عملة الصفقة.",
  ],
  FinanceSettlementAdviceAccessUnavailable: [
    "Your account cannot correct this advice. Refresh the deal and contact a manager if you still need access.",
    "لا يملك حسابك صلاحية تصحيح هذا الإشعار. حدّث الصفقة وتواصل مع مدير إذا كنت لا تزال بحاجة إلى الصلاحية.",
  ],
  FinanceSettlementAdviceSignInRequired: [
    "Sign in again and reopen the deal before correcting the advice.",
    "سجّل الدخول مجددًا وافتح الصفقة قبل تصحيح الإشعار.",
  ],
  FinanceSettlementAdviceOutcomeUnknown: [
    "We couldn’t confirm whether the correction was saved. You can retry here with the same details. If you need to change the details, reload the deal and check the recorded advice first.",
    "تعذّر تأكيد حفظ التصحيح. يمكنك إعادة المحاولة هنا بالبيانات نفسها. إذا أردت تغيير البيانات، فأعد تحميل الصفقة وراجع الإشعار المسجّل أولًا.",
  ],
});

export const financeCockpitErrors = {
  en: { ...financeCockpitLegacyRefusals.en, ...settlementAdviceRecovery.en },
  ar: { ...financeCockpitLegacyRefusals.ar, ...settlementAdviceRecovery.ar },
};
