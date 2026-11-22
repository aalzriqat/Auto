import { defineBilingualMessages } from "../../defineBilingualMessages";

export const handoverCostStatusMessages = defineBilingualMessages({
  /** رسوم ومصاريف تسليم السيارة — the handover-cost section on the Deal. */
  HandoverCostsHeading: ["Vehicle handover fees and costs", "رسوم ومصاريف تسليم السيارة"],
  HandoverCostsNote: [
    "Costs of handing this car to this customer — transfer, licensing, plates, paperwork, inspection, delivery insurance. Not the car's purchase, import or preparation.",
    "تكاليف تسليم هذه السيارة لهذا العميل — نقل الملكية، الترخيص، اللوحات، المعاملات، الفحص، تأمين التسليم. لا تشمل شراء السيارة أو استيرادها أو تجهيزها.",
  ],
  HandoverCostsUnavailable: [
    "Cost lines are not readable with your permissions.",
    "لا يمكن قراءة بنود التكاليف بصلاحياتك الحالية.",
  ],
  HandoverCostsLoading: ["Loading cost lines…", "جارٍ تحميل بنود التكاليف…"],
  HandoverCostsMixedCurrency: [
    "These lines are not all in the deal's currency; totals are not available until the records agree.",
    "ليست كل هذه البنود بعملة الصفقة؛ الإجماليات غير متاحة حتى تتوافق السجلات.",
  ],
  HandoverCostsUnreadableAmount: [
    "A cost amount on this deal could not be read; totals are withheld, not shown as zero, until the line is corrected.",
    "تعذّرت قراءة أحد مبالغ التكاليف على هذه الصفقة؛ الإجماليات محجوبة، لا صفرًا، حتى يُصحَّح البند.",
  ],
  HandoverCostOutcomeUnknown: [
    "The last attempt's result never arrived, so that cost may already be recorded. Check the lines above before adding it again.",
    "لم تصل نتيجة المحاولة الأخيرة، لذا قد يكون ذلك المصروف مسجّلاً بالفعل. راجع البنود أعلاه قبل إضافته من جديد.",
  ],
  HandoverCostCurrencyDiffers: [
    "Recorded in a different currency from the deal's; not editable here.",
    "مسجّل بعملة تختلف عن عملة الصفقة؛ لا يمكن تعديله هنا.",
  ],
  HandoverCostRetryFrozen: [
    "The server refused this attempt; nothing was recorded. Retry sends exactly what was entered; to change anything, cancel and add the cost again.",
    "رفض الخادم هذه المحاولة ولم يُسجَّل شيء. تُعيد المحاولة إرسال ما أُدخل بالضبط؛ لتغيير أي شيء، ألغِ وأضف المصروف من جديد.",
  ],
  HandoverCostRetryFrozenUnknown: [
    "The result of this attempt never arrived; the cost may already be recorded. Retry resends the same request without duplicating it. Cancelling does not undo a recorded cost.",
    "لم تصل نتيجة هذه المحاولة؛ قد يكون المصروف مسجّلاً بالفعل. تُعيد المحاولة إرسال الطلب نفسه دون تكراره. الإلغاء لا يلغي مصروفاً مسجّلاً.",
  ],
  RetryHandoverCost: ["Retry", "إعادة المحاولة"],
  HandoverCostAcknowledgeChecked: ["I have checked the lines", "راجعتُ البنود"],
});

export const handoverCostMessages = defineBilingualMessages({
  NoHandoverCosts: ["No handover costs recorded yet.", "لم تُسجَّل مصاريف تسليم بعد."],
  AddHandoverCost: ["Add cost", "إضافة مصروف"],
  SaveHandoverCost: ["Save cost", "حفظ المصروف"],
  RecordActualCost: ["Record actual", "تسجيل الفعلي"],
  SaveActualCost: ["Save actual", "حفظ الفعلي"],
  RemoveHandoverCost: ["Remove cost", "إزالة المصروف"],
  ConfirmRemoveCost: ["Remove", "إزالة"],
  HandoverCostSaved: ["Handover cost saved", "تم حفظ مصروف التسليم"],
  HandoverCostRemoved: ["Handover cost removed", "تمت إزالة مصروف التسليم"],
  CostsExpectedTotal: ["Expected", "المتوقّع"],
  CostsActualTotal: ["Recorded actual", "الفعلي المسجّل"],
  CostsAwaitingActual: ["Lines awaiting an actual", "بنود بانتظار الفعلي"],
  CostEstimated: ["Estimated", "تقديري"],
  CostActual: ["Actual", "فعلي"],
  CostTypeLabel: ["Cost type", "نوع المصروف"],
  CostPayeeLabel: ["Paid to", "مدفوع إلى"],
  // A handover cost is always paid out of an employee's custody cash (owner
  // ruling 2026-09-28, SCRUM-439).
  CostPaidFromCustodyLabel: ["Paid from the custody cash of", "مدفوع من نقد عهدة"],
  CostPaidFromCustodyHeading: ["Paid from custody cash", "مدفوع من نقد العهدة"],
  CostPaidByChoose: ["Choose the employee…", "اختر الموظف…"],
  CostPaidFromCustodyNote: [
    "Handover costs are paid from custody cash. This one is charged to that employee's custody now and counts toward what they account for when it is reconciled.",
    "تُدفع مصاريف التسليم من نقد العهدة. يُحمَّل هذا المصروف على عهدة الموظف الآن، ويُحتسب ضمن ما يبرّره عند تسويتها.",
  ],
  CostPaidFromCustodyPendingNote: [
    "Handover costs are paid from custody cash. This one is recorded as the employee's and waits under “Charge a cost” in Employee cash custody for a manager or accountant to charge it.",
    "تُدفع مصاريف التسليم من نقد العهدة. يُسجَّل هذا المصروف باسم الموظف، وينتظر في «تحميل مصروف» ضمن عهدة الموظف النقدية ليحمّله مدير أو محاسب.",
  ],
  CostPaidByRequired: ["Choose whose custody paid this cost.", "اختر العهدة التي دُفع منها هذا المصروف."],
  CostPaidFromCustodyGone: [
    "That custody record can no longer take this cost from here. Choose the employee again.",
    "لم يعد بالإمكان تحميل المصروف على سجل العهدة هذا من هنا. اختر الموظف مجددًا.",
  ],
  CostPaidFromCustodyGoneNone: [
    "That custody record can no longer take this cost from here, and no other custody can take it now. Record it as the employee's cost for now; it can be charged to a custody from “Charge a cost” later.",
    "لم يعد بالإمكان تحميل المصروف على سجل العهدة هذا من هنا، ولا توجد عهدة أخرى يمكن تحميله عليها الآن. سجّله مصروفًا على الموظف الآن، ويمكن تحميله على عهدة لاحقًا من «تحميل مصروف».",
  ],
  CostPaidFromCustodyRelease: ["Record without charging a custody", "سجّل دون تحميله على عهدة"],
  HandoverCostNeedsCustody: [
    "Handover costs are paid from custody cash, and no employee holds any for this deal yet. This cost is recorded as the employee's; hand them the cash under Employee cash custody, then charge it there with “Charge a cost”.",
    "تُدفع مصاريف التسليم من نقد العهدة، ولا يحمل أي موظف نقدًا لهذه الصفقة بعد. يُسجَّل هذا المصروف باسم الموظف؛ سلِّمه النقد من قسم عهدة الموظف النقدية، ثم حمِّله عليها من «تحميل مصروف».",
  ],
  CostDescriptionLabel: ["Description (optional)", "الوصف (اختياري)"],
  CostFigureLabel: ["Figure", "الرقم"],
  // The checklist the finance company's frozen policy implies (owner product
  // correction, #scrum-215 2026-09-12 21:05): expected is read-only and comes
  // from the deal's rule snapshot; the operator records actuals only.
  HandoverExpectedHeading: ["From the finance company's policy", "بحسب سياسة شركة التمويل"],
  HandoverExpectedNote: [
    "Expected amounts come from the finance company's fee settings as they were when this deal was created. Record only what was actually paid; the expectation is never edited here.",
    "المبالغ المتوقّعة مأخوذة من إعدادات رسوم شركة التمويل كما كانت عند إنشاء هذه الصفقة. سجِّل ما دُفع فعليًا فقط؛ لا يُعدَّل المتوقّع هنا.",
  ],
  HandoverExpectedNotConfigured: [
    "This deal's finance company had no fees configured when the deal was created, so nothing is expected from its policy. Record what was actually paid as additional costs.",
    "لم تكن لدى شركة التمويل رسوم مضبوطة عند إنشاء هذه الصفقة، فلا يوجد متوقّع بحسب سياستها. سجِّل ما دُفع فعليًا كمصاريف إضافية.",
  ],
  HandoverExpectedNoSnapshot: [
    "This deal carries no record of its finance company's rules, so nothing is expected from its policy.",
    "لا تحمل هذه الصفقة سجلًا لقواعد شركة التمويل، فلا يوجد متوقّع بحسب سياستها.",
  ],
  CostExpected: ["Expected", "المتوقّع"],
  CostNotRecorded: ["Not recorded", "غير مسجّل"],
  ExecutionFeeLabel: ["Finance company execution fee", "رسوم تنفيذ شركة التمويل"],
  ExecutionFeeNote: [
    "Paid by the dealership separately — the finance company remits the full approved amount.",
    "تدفعها الوكالة بشكل منفصل — تحوّل شركة التمويل كامل المبلغ الموافق عليه.",
  ],
  ExecutionFeeUnrecorded: [
    "Record what the dealership actually paid for this fee (zero if it was not charged), or link the cost already recorded for it. The deal cannot be finalized until then.",
    "سجِّل ما دفعته الوكالة فعليًا لهذه الرسوم (صفر إن لم تُستوفَ)، أو اربط المصروف المسجَّل لها. لا يمكن إتمام الصفقة قبل ذلك.",
  ],
  ExecutionFeeRecordedElsewhere: [
    "If this fee is already recorded above under another cost type, remove that cost first and then record the fee here — recording it twice counts and pays it twice.",
    "إن كانت هذه الرسوم مسجَّلة أعلاه بنوع مصروف آخر، فاحذف ذلك المصروف أولًا ثم سجِّل الرسوم هنا — تسجيلها مرتين يحتسبها ويدفعها مرتين.",
  ],
  ExecutionFeeLinkedTo: ["Linked to", "مرتبطة بـ"],
  ExecutionFeeLinkLabel: ["Already recorded as a cost?", "مسجَّلة مسبقًا كمصروف؟"],
  ExecutionFeeLinkPlaceholder: ["Choose the cost…", "اختر المصروف…"],
  ExecutionFeeLink: ["Link", "ربط"],
  ExecutionFeeRecord: ["Record execution fee", "تسجيل رسوم التنفيذ"],
  ExecutionFeeUnlink: ["Unlink from execution fee", "فكّ الربط برسوم التنفيذ"],
  ExecutionFeeUnlinkNote: [
    "The cost stays on the deal as an ordinary cost, and the execution fee becomes unrecorded again.",
    "يبقى المصروف على الصفقة كمصروف عادي، وتعود رسوم التنفيذ غير مسجَّلة.",
  ],
  ExecutionFeeRecorded: ["Execution fee recorded", "سُجِّلت رسوم التنفيذ"],
  ExecutionFeeLinked: ["Execution fee linked", "رُبطت رسوم التنفيذ"],
  ExecutionFeeUnlinked: ["Execution fee unlinked", "فُكّ ربط رسوم التنفيذ"],
  CostsDifference:["Expected − actual", "المتوقّع − الفعلي"],
  CostsDifferenceNote: [
    "A comparison only — not an amount still owed.",
    "للمقارنة فقط — وليس مبلغًا لا يزال مستحقًا.",
  ],
  RecordTemplateActual: ["Record actual", "تسجيل الفعلي"],
  TemplateConfiguredTwice: ["Configured twice", "مضبوط مرتين"],
  AdditionalCostsHeading: ["Additional costs", "مصاريف إضافية"],
  AddAdditionalCost: ["Add additional cost", "إضافة مصروف إضافي"],
  AdditionalCostNote: [
    "A cost that was not configured on the finance company. It is recorded as actually paid and does not change the expected total.",
    "مصروف غير مضبوط لدى شركة التمويل. يُسجَّل كما دُفع فعليًا ولا يغيّر إجمالي المتوقّع.",
  ],
  CostAmountLabel: ["Amount", "المبلغ"],
  CostAmountRequired: ["Enter a valid amount.", "أدخل مبلغًا صحيحًا."],
  CostPaidOnLabel: ["Paid on", "تاريخ الدفع"],
  ReceiptReferenceLabel: ["Receipt reference", "مرجع الإيصال"],
  CostTreatmentLabel: ["Accounting treatment", "المعالجة المحاسبية"],
  CostTreatmentNote: [
    "Pre-selected for the cost type; the record states it explicitly rather than inferring it.",
    "محدَّدة مسبقًا حسب نوع المصروف؛ يُسجَّل ذلك صراحةً ولا يُستنتج.",
  ],
  CostEstimatePreservedNote: [
    "the estimate stays on the line beside the actual.",
    "يبقى التقدير على البند إلى جانب الفعلي.",
  ],
  CostReconciledEditNote: [
    "This figure was reconciled; changing it withdraws the reconciliation and is refused without the permission to do so.",
    "هذا الرقم مُطابَق؛ تغييره يسحب المطابقة ويُرفض دون صلاحية ذلك.",
  ],
  HandoverCostAfterCloseNote: [
    "The sale is recognized: its costs, invoice and custody charges are on the books and can no longer be added, changed or removed from here.",
    "تم إثبات البيع: مصاريفه وفاتورته وتحميلات العهدة مُرحَّلة في الدفاتر ولا يمكن إضافتها أو تعديلها أو إزالتها من هنا بعد الآن.",
  ],
  VoidCostNote: [
    "The line is kept on record as void with your reason — nothing is deleted, and removing a cost is not a refund.",
    "يبقى البند مسجّلًا كملغى مع سببك — لا يُحذف شيء، وإزالة المصروف ليست استردادًا.",
  ],
  VoidReasonLabel: ["Reason", "السبب"],
  VoidReasonRequired: ["Say why this cost is being removed.", "اذكر سبب إزالة هذا المصروف."],
  VoidedCostsSummary: ["removed cost lines", "بنود مصاريف مُزالة"],
  CostStatusUnquantified: ["No amount yet", "بلا مبلغ بعد"],
  CostStatusEstimated: ["Estimated only", "تقديري فقط"],
  CostStatusActual: ["Actual recorded", "فعلي مسجّل"],
  CostStatusReconciled: ["Reconciled", "مُطابَق"],
  CostStatusVoid: ["Void", "ملغى"],
  // SCRUM-443 — who paid a handover cost, and how the dealership records paying one itself.
  HandoverPaymentPaidCustody: ["Paid from custody", "مدفوع من العهدة"],
  // A custody charge is on the row but its posting has not been confirmed on the
  // ledger (an accounting period is closed, or the queue has not processed it).
  HandoverPaymentCustodyRecorded: ["Recorded — waiting for posting", "مسجَّل — بانتظار الترحيل"],
  HandoverPaymentUnsupportedTreatment: [
    "This cost's accounting treatment cannot be paid or posted, so it would never reach the books. Remove it and add it again as an ownership transfer, insurance or selling expense; it is then settled from the employee's custody or by a direct dealership payment, as applicable.",
    "المعالجة المحاسبية لهذا المصروف لا يمكن دفعها أو ترحيلها، فلن يصل إلى الدفاتر أبدًا. احذفه وأضفه من جديد كمصروف نقل ملكية أو تأمين أو بيع؛ وعندئذٍ تتم تسويته من عهدة الموظف أو بدفع مباشر من المعرض بحسب الحال.",
  ],
  HandoverPaymentDeductionNotRecognised: [
    "This cost is marked as deducted from the finance company's settlement, but this deal has no configured financing plan to recognise it, so it would never reach the books. Remove it and add it again without the settlement deduction, then pay it.",
    "هذا المصروف معلَّم كمخصوم من تسوية شركة التمويل، لكن هذه الصفقة بلا خطة تمويل مُعدّة تعترف به، فلن يصل إلى الدفاتر أبدًا. احذفه وأضفه من جديد دون خصم التسوية، ثم سجّل دفعه.",
  ],
  HandoverPaymentLegacyTemplateReview: [
    "This cost comes from the finance company's older fee setup, and its accounting treatment cannot be paid or posted as recorded. It cannot be corrected from the deal — ask an accountant or administrator to review it.",
    "هذا المصروف مصدره إعداد الرسوم القديم لشركة التمويل، ولا يمكن دفع معالجته المحاسبية أو ترحيلها كما هي مسجّلة. ولا يمكن تصحيحه من الصفقة — اطلب من المحاسب أو المسؤول مراجعته.",
  ],
  HandoverPaymentPaidDirect: ["Paid by the dealership", "دفعه المعرض مباشرةً"],
  HandoverPaymentUnpaid: ["Payment not recorded", "الدفع غير مسجَّل"],
  HandoverPaymentNoActual: ["Record its actual amount first", "سجّل مبلغه الفعلي أولًا"],
  HandoverPaymentConflict: ["Recorded as paid twice — needs review", "مسجَّل كمدفوع مرتين — يحتاج مراجعة"],
  HandoverPaymentNeedsCustody: [
    "Paid by an employee: charge it to that employee's custody under Employee cash custody.",
    "دفعه موظف: حمِّله على عهدة ذلك الموظف من قسم عهدة الموظف النقدية.",
  ],
  RecordDirectPayment: ["Record direct payment", "تسجيل دفع مباشر"],
  ReconcileNeedsAccountant: [
    "Waiting for an accountant or a manager to reconcile this cost.",
    "بانتظار محاسب أو مدير لمطابقة هذه التكلفة.",
  ],
  ReconciledNeedsAccountant: [
    "Reconciled. Changing or removing it needs someone who can confirm finance disbursements.",
    "تمت المطابقة. تعديل المبلغ أو إزالته يتطلب شخصاً يملك صلاحية تأكيد صرف التمويل.",
  ],
  DirectPaymentWaiting: [
    "Waiting for a manager or an accountant to record the payment.",
    "بانتظار مدير أو محاسب لتسجيل الدفع.",
  ],
  DirectPaymentNote: [
    "Use this when the dealership itself paid the cost (bank transfer, e-payment, cash or an issued cheque) rather than an employee out of custody cash. It posts to the books from the account you choose, dated the day it was paid; if no accounting period is open for that date it waits, and the line shows it as waiting.",
    "استخدمه عندما دفع المعرض المصروف بنفسه (حوالة بنكية أو دفع إلكتروني أو نقدًا أو بشيك صادر) لا موظف من نقد العهدة. يُرحَّل إلى الدفاتر من الحساب الذي تختاره بتاريخ الدفع؛ وإن لم تكن هناك فترة محاسبية مفتوحة لذلك التاريخ فإنه ينتظر، ويظهر البند على أنه بانتظار الترحيل.",
  ],
  HandoverPaymentRecordedUnconfirmed: [
    "Recorded — ledger status is confirmed at closing",
    "مسجَّل — يُتأكد من حالته في الدفاتر عند الإغلاق",
  ],
  HandoverPaymentRecordedCancelled: [
    "Recorded — deal cancelled",
    "مسجَّل — الصفقة ملغاة",
  ],
  HandoverPaymentRecordedRejected: [
    "Recorded — deal rejected",
    "مسجَّل — الصفقة مرفوضة",
  ],
  // A stopped (CANCELLED or REJECTED) deal accepts no new custody cash or direct
  // payment. Only when its economics are also frozen (finalized or CLOSED) is
  // nothing actionable, so this wording is for that case; an unfrozen stopped
  // deal can still remove a cost, so it gets the Employee / Remove variants below.
  HandoverPaymentUntreatableStopped: [
    "This cost's accounting treatment cannot be paid or posted as recorded. The deal is stopped, so no payment or settlement can be recorded for it now.",
    "المعالجة المحاسبية لهذا المصروف لا يمكن دفعها أو ترحيلها كما هي مسجّلة. الصفقة متوقفة، فلا يمكن تسجيل دفع أو تسوية له الآن.",
  ],
  HandoverPaymentUntreatableStoppedEmployee: [
    "This cost's accounting treatment cannot be paid or posted as recorded. The deal is stopped, so no new cash can be handed out for it. Remove it and add it again as an ownership transfer, insurance or selling expense; it can then be settled from custody the employee already holds.",
    "لا يمكن دفع المعالجة المحاسبية لهذا المصروف أو ترحيلها كما هي مسجّلة. الصفقة متوقفة، فلا يمكن صرف مبلغ نقدي جديد له. أزِله ثم أضِفه من جديد كنقل ملكية أو تأمين أو مصروف بيع؛ عندها يمكن تسويته من العهدة التي يحتفظ بها الموظف بالفعل.",
  ],
  HandoverPaymentUntreatableStoppedRemove: [
    "This cost's accounting treatment cannot be paid or posted as recorded. The deal is stopped, so no new payment can be recorded for it. Remove it so it does not stay on the deal.",
    "لا يمكن دفع المعالجة المحاسبية لهذا المصروف أو ترحيلها كما هي مسجّلة. الصفقة متوقفة، فلا يمكن تسجيل دفعة جديدة له. أزِله حتى لا يبقى على الصفقة.",
  ],
  HandoverPaymentStoppedNoNewPayment: [
    "The deal is stopped, so no new payment is recorded for this cost.",
    "الصفقة متوقفة، فلا تُسجَّل دفعة جديدة لهذا المصروف.",
  ],
  DirectPaymentAmountChanged: [
    "The amount of this cost changed since you opened this form. It is now:",
    "تغيّر مبلغ هذا المصروف منذ فتحت هذا النموذج. المبلغ الآن:",
  ],
  DirectPaymentUseNewAmount: ["Review and use the new amount", "راجِع المبلغ الجديد واعتمده"],
  HandoverPaymentQueued: ["Recorded — waiting to post to the books", "مسجَّل — بانتظار الترحيل إلى الدفاتر"],
  HandoverPaymentQueuedNote: [
    "This payment is not on the books yet — usually because no accounting period is open for its date. Open the period and let the accounting queue process; the deal cannot close until it posts.",
    "هذا الدفع لم يدخل الدفاتر بعد — غالبًا لأنه لا توجد فترة محاسبية مفتوحة لتاريخه. افتح الفترة واترك طابور المحاسبة يعالجه؛ لا يمكن إغلاق الصفقة قبل ترحيله.",
  ],
  HandoverPaymentReversalPending: [
    "An earlier payment of this cost is still on the books: its reversal is waiting for an accounting period to open for the date it was taken back (usually today). Open that period (or wait for the reversal to post) before closing the deal.",
    "دفعة سابقة لهذا المصروف ما زالت في الدفاتر: عكس قيدها بانتظار فتح فترة محاسبية لتاريخ التراجع عنها (غالبًا اليوم). افتح تلك الفترة (أو انتظر ترحيل عكس القيد) قبل إغلاق الصفقة.",
  ],
  DirectPaymentMethodLabel: ["Paid by", "طريقة الدفع"],
  DirectPaymentMethodChoose: ["Choose how it was paid…", "اختر طريقة الدفع…"],
  DirectPaymentMethodRequired: ["Choose how the dealership paid.", "اختر كيف دفع المعرض."],
  DirectPaymentDateRequired: ["Choose the date it was paid.", "اختر تاريخ الدفع."],
  SaveDirectPayment: ["Save payment", "حفظ الدفع"],
  DirectPaymentSaved: ["Direct payment recorded", "تم تسجيل الدفع المباشر"],
  DirectPaymentChangeNote: [
    "Changing this cost's amount or removing it reverses this payment; record it again afterwards.",
    "تغيير مبلغ هذا المصروف أو إزالته يعكس هذا الدفع؛ سجّله من جديد بعد ذلك.",
  ],
  DirectPaymentChangeNoteStopped: [
    "Changing this cost's amount or removing it still reverses this payment, but the deal is stopped, so it cannot be recorded again.",
    "تغيير مبلغ هذا المصروف أو إزالته ما زال يعكس هذا الدفع، لكن الصفقة متوقفة، فلا يمكن تسجيله من جديد.",
  ],
  FeeTypeFinanceCompany: ["Finance company fee", "رسوم جهة التمويل"],
  FeeTypeAppraisal: ["Appraisal fee", "رسوم التقييم"],
  FeeTypeInsurance: ["Insurance", "التأمين"],
  FeeTypeStamps: ["Stamps", "الطوابع"],
  FeeTypeLicensing: ["Licensing / plates", "الترخيص / اللوحات"],
  FeeTypeOwnershipTransfer: ["Ownership transfer", "نقل الملكية"],
  FeeTypeLienRegistration: ["Lien registration", "تسجيل الرهن"],
  FeeTypeLienRelease: ["Lien release", "فك الرهن"],
  FeeTypeInspection: ["Inspection", "الفحص"],
  FeeTypeAdministrative: ["Administrative fee", "رسوم إدارية"],
  FeeTypeCommission: ["Commission", "العمولة"],
  FeeTypeOtherClosing: ["Other handover expense", "مصروف تسليم آخر"],
  TreatmentOwnershipTransferExpense: ["Ownership-transfer expense", "مصروف نقل ملكية"],
  TreatmentSellingExpense: ["Selling expense", "مصروف بيع"],
  TreatmentInsuranceExpense: ["Insurance expense", "مصروف تأمين"],
  TreatmentCustomerReceivable: ["Recoverable from the customer", "مستحق على العميل"],
  PayeeGovernment: ["Government", "جهة حكومية"],
  PayeeInsurer: ["Insurer", "شركة التأمين"],
  PayeeOther: ["Other", "أخرى"],
  /** Prefix for the organisation's current currency beside it. */
  OrganisationCurrencyLabel: ["Organisation currency", "عملة المؤسسة"],
});
