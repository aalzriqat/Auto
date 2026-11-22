import { defineBilingualMessages } from "../../defineBilingualMessages";

export const dealShortfallMessages = defineBilingualMessages({
  // --- Appraisal gap resolution (SCRUM-83) — the GAP_RESOLUTION stage's one action.
  // SCRUM-766: what the parties split is the NET shortfall - what the quotation
  // promised the showroom would receive minus what it will now receive - never
  // the raw quotation-minus-approval difference, so none of these say "appraisal gap".
  ResolveGapAction: ["Resolve the shortfall", "حل العجز"],
  GapResolved: ["Recorded who covers the shortfall.", "سُجِّلت الجهة التي تتحمّل العجز."],
  GapResolutionNeedsPermission: [
    "The dealership owner records who covers the difference.",
    "يسجّل مالك المعرض الجهة التي تتحمّل الفرق.",
  ],
  // A DIFFERENT obstacle: this person may record the agreement, but the deal's
  // figures are not shown to them, and the shortfall is one of those figures.
  GapResolutionNeedsDealFigures: [
    "This deal's figures are not available to you, so the difference cannot be settled here.",
    "أرقام هذه الصفقة غير متاحة لك، لذا لا يمكن تسوية الفرق من هنا.",
  ],
  // The deal has moved past the point where this can be agreed: handover seals
  // the figures and closing writes the sale against them, so the server refuses.
  GapResolutionSealed: [
    "This deal has already moved on, so who covers the difference can no longer be recorded here.",
    "تجاوزت هذه الصفقة هذه المرحلة، فلم يعد بالإمكان تسجيل الجهة التي تتحمّل الفرق من هنا.",
  ],
  GapResolutionSelfDeal: [
    "You cannot settle the shortfall on your own deal. The dealership owner records it.",
    "لا يمكنك تسوية العجز على صفقتك أنت. يسجّله مالك المعرض.",
  ],
  ResolveGapTitle: ["Resolve the shortfall", "حل العجز"],
  ResolveGapDescription: [
    "The finance company will pay the showroom less than the quotation promised. Record what the customer and the dealership each cover, and where the customer's part is actually paid.",
    "ستدفع شركة التمويل للمعرض أقل مما وعد به عرض السعر. سجّل ما يتحمّله العميل وما يتحمّله المعرض، وأين يُدفع نصيب العميل فعلياً.",
  ],
  GapRecordedQuotation: ["Submitted quotation", "عرض السعر المرسل"],
  GapApprovedAmount: ["Approved by the finance company", "المبلغ المعتمد من شركة التمويل"],
  ResolveGapAmount: ["The shortfall", "العجز"],
  // The two causes of the total, shown only when the server worked it out as a
  // NET figure. They always add up to the total above.
  GapShortfallFromValuation: ["From the lower approved amount", "بسبب انخفاض المبلغ المعتمد"],
  GapShortfallFromTerms: ["From the changed financing terms", "بسبب تغيّر شروط التمويل"],
  // A manual approval records the finance company's letter, which carries no
  // quotation baseline, so the figure is the gross quotation-minus-approval.
  GapShortfallGrossManual: [
    "Gross figure: a manually recorded approval has no breakdown.",
    "رقم إجمالي: الموافقة المسجّلة يدوياً لا تتضمن تفصيلاً.",
  ],
  GapShortfallUnavailable: [
    "The shortfall cannot be worked out for this deal, because its quotation did not record the figures it was based on. Re-record the quotation and the approval.",
    "تعذّر احتساب العجز لهذه الصفقة، لأن عرض السعر لم يسجّل الأرقام التي بُني عليها. أعد تسجيل عرض السعر والموافقة.",
  ],
  ResolveGapWhoAbsorbs: ["Who covers it", "من يتحمّله"],
  GapCustomerAbsorbs: ["The customer covers it", "يتحمّله العميل"],
  GapCustomerAbsorbsHint: ["The customer covers the whole difference.", "يتحمّل العميل الفرق كاملاً."],
  GapSplit: ["Customer and dealership split it", "يتقاسمه العميل والمعرض"],
  GapSplitHint: ["Enter the customer's part; the dealership's is what remains.", "أدخل نصيب العميل، ويتحمّل المعرض الباقي."],
  GapDealerAbsorbs: ["The dealership covers it", "يتحمّله المعرض"],
  GapDealerAbsorbsHint: [
    "The dealership covers the whole difference; nothing is collected from the customer for it.",
    "يتحمّل المعرض الفرق كاملاً، ولا يُحصَّل شيء من العميل مقابله.",
  ],
  // Shown INSTEAD of the two above once a supplier concession is entered (SCRUM-766 PR-C,
  // review of PR #697): the option is about the customer owing nothing, and the sentence
  // must not say the dealership covers a difference the supplier is covering.
  GapNoCustomerPart: ["The customer pays no part", "لا يدفع العميل أي جزء"],
  GapNoCustomerPartHintShared: [
    "Nothing is collected from the customer. The supplier concession entered below is deducted, and the dealership covers the rest.",
    "لا يُحصَّل شيء من العميل. يُخصم تنازل المورّد المُدخل أدناه، ويتحمّل المعرض الباقي.",
  ],
  GapNoCustomerPartHintSupplier: [
    "Nothing is collected from the customer. The supplier concession entered below covers the whole difference, so the dealership covers nothing.",
    "لا يُحصَّل شيء من العميل. يغطي تنازل المورّد المُدخل أدناه الفرق كاملاً، فلا يتحمّل المعرض شيئاً.",
  ],
  GapCustomerShare: ["The customer's part", "نصيب العميل"],
  GapDealerShare: ["The dealership then covers", "ويتحمّل المعرض"],
  GapWhereCustomerPays: ["Where the customer's part is paid", "أين يُدفع نصيب العميل"],
  GapWhereCustomerPaysHint: [
    "Money paid to the dealership is dealership income. Money the customer pays the finance company directly is not: once the payment is confirmed, it lowers what the dealership has to put in, by the same amount. Until then the dealership's contribution is unchanged and the deal cannot close.",
    "ما يُدفع للمعرض دخلٌ للمعرض. أما ما يدفعه العميل لشركة التمويل مباشرةً فليس دخلاً، بل يُخفِّض ما على المعرض أن يدفعه بالمبلغ نفسه بعد تأكيد الدفعة. وقبل ذلك تبقى مساهمة المعرض كما هي ولا يمكن إغلاق الصفقة.",
  ],
  GapWhereCustomerPaysManualHint: [
    "Money paid to the dealership is dealership income, so it is recorded here rather than assumed.",
    "ما يُدفع للمعرض دخلٌ للمعرض، لذا يُسجَّل هنا بدل افتراضه.",
  ],
  GapCashToDealer: ["Cash to us", "نقداً لنا"],
  GapInstallmentsToDealer: ["Instalments to us", "أقساطاً لنا"],
  GapToFinanceCompany: ["To the finance company", "لشركة التمويل"],
  // Shown INSTEAD of the all-placed line while any destination is blank. It has
  // to name the remedy, because the Confirm button is disabled at this point.
  GapDestinationsIncomplete: [
    "Enter an amount in every box — put 0 where nothing was paid that way.",
    "أدخل مبلغاً في كل خانة، وضع 0 حيث لم يُدفع شيء بتلك الطريقة.",
  ],
  GapShareMissing: ["Enter the customer's part of the difference.", "أدخل نصيب العميل من الفرق."],
  // The remedy is the OTHER option, not a different number.
  GapSplitIsWholeGap: [
    "The customer's part equals the whole difference — choose \"The customer covers it\" instead.",
    "نصيب العميل يساوي الفرق كاملاً — اختر «يتحمّله العميل» بدلاً من ذلك.",
  ],
  GapSplitLeavesCustomerNothing: [
    "A split must leave the customer a part — choose \"The dealership covers it\" instead.",
    "التقاسم يستلزم نصيباً للعميل — اختر «يتحمّله المعرض» بدلاً من ذلك.",
  ],
  GapAllocationMismatch: [
    "The amounts must add up to exactly the customer's part.",
    "يجب أن يساوي مجموع المبالغ نصيب العميل بالضبط.",
  ],
  GapAllocationComplete: ["Everything is accounted for.", "كل شيء محسوب."],
  // SCRUM-766 PR-C: the supplier of a SOURCED vehicle concedes part of its
  // entitlement. Optional; blank means none.
  GapSupplierConcession: ["Supplier concession (optional)", "تنازل المورّد (اختياري)"],
  GapSupplierEntitlement: ["The supplier is owed", "المستحق للمورّد"],
  GapSupplierConcessionHint: [
    "Part of the shortfall the supplier agrees to bear by taking less. Leave blank if none.",
    "جزء من العجز يقبل المورّد تحمّله بتقاضي مبلغ أقل. اتركه فارغاً إن لم يوجد.",
  ],
  GapSupplierInvalid: [
    "The supplier concession must be a valid amount, or left blank.",
    "يجب أن يكون تنازل المورّد مبلغاً صحيحاً أو يُترك فارغاً.",
  ],
  GapSupplierTooLarge: [
    "The supplier concession must be less than what the supplier is owed.",
    "يجب أن يقلّ تنازل المورّد عن المبلغ المستحق له.",
  ],
  GapNotes: ["Notes (optional)", "ملاحظات (اختياري)"],
});
