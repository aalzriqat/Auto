import { defineBilingualMessages } from "../defineBilingualMessages";

export const financeCockpitErrors = defineBilingualMessages({
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
