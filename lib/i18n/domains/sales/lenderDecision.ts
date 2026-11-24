import { defineBilingualMessages } from "../../defineBilingualMessages";

const financeDecisionMessages = defineBilingualMessages({
  // --- Recording the finance company's own figures ----------------------
  // Every string here says the dealership RECORDS what the finance company
  // decided. None of them may read as AutoFlow approving anything: the
  // approval happens at the company, on paper, before anyone opens this
  // screen, and copy that blurs the two would make the system look like the
  // decision-maker for a decision it only ever mirrors.
  // --- تسجيل أرقام شركة التمويل ------------------------------------------
  FinanceDecisionHeading: ["What the finance company told us", "ما أبلغتنا به شركة التمويل"],
  FinanceDecisionIntro: [
    "AutoFlow records the finance company's own figures. It does not approve financing.",
    "يسجّل أوتوفلو أرقام شركة التمويل كما وردت منها. أوتوفلو لا يمنح موافقة على التمويل.",
  ],
  QuotationSubmittedLabel: ["Quotation we submitted", "عرض السعر المُرسَل"],
  ApprovedPurchaseLabel: ["Amount the finance company approved", "المبلغ المعتمد من شركة التمويل"],
  NotRecordedYet: ["Not recorded yet", "غير مُسجَّل بعد"],
  /** Recorded, but this caller may not see the amount — never "not recorded". */
  RecordedAmountHidden: ["Recorded — you cannot see the amount", "مُسجَّل — لا تملك صلاحية عرض المبلغ"],
  RecordQuotationAction: ["Record quotation", "تسجيل عرض السعر"],
  FinanceCompanyLtvMissing: [
    "This deal was created before its finance company had a purchase LTV, and a deal keeps the rules it was created under. Record the rate that applies to this deal when you record the quotation.",
    "أُنشئت هذه الصفقة قبل تسجيل نسبة الشراء لشركة التمويل، وتبقى كل صفقة خاضعة للقواعد التي أُنشئت بها. سجِّل النسبة الخاصة بهذه الصفقة عند تسجيل عرض السعر.",
  ],
  DealPurchaseLtvLabel: ["Purchase LTV for this deal (%)", "نسبة الشراء لهذه الصفقة (%)"],
  DealPurchaseLtvHint: [
    "The share of the vehicle the finance company buys at, for this deal only. Setting the rate on the company itself applies to future deals, not to this one.",
    "نسبة قيمة المركبة التي تشتريها شركة التمويل، لهذه الصفقة فقط. أما ضبط النسبة على الشركة نفسها فيسري على الصفقات القادمة لا على هذه.",
  ],
  DealPurchaseLtvInvalid: [
    "Enter a rate greater than zero and no more than 100.",
    "أدخل نسبة أكبر من صفر ولا تتجاوز 100.",
  ],
  /**
   * Shown to a caller who cannot record this deal's missing rate themselves —
   * on the quotation row instead of the self-service instruction, and in the
   * dialog instead of the rate field. Says who unblocks it, because a disabled
   * control with no named owner is a dead end.
   *
   * Names ALL THREE permissions the recovery actually needs (SCRUM-322): the
   * rate is only ever written together with the quotation, so the actor must
   * hold `create:finance_application` as well as the rate authority
   * (`approve:finance_application` + `view:finance`). Naming only the rate
   * authority sent a custom role holding exactly that, and no CREATE, to an
   * action it cannot take. The dealership owner holds all three.
   */
  DealPurchaseLtvNeedsApprover: [
    "This deal was created before its finance company had a purchase LTV, and a deal keeps the rules it was created under. The quotation and the rate the finance company confirmed for this deal must be recorded together, by someone who can record finance applications, approve them and view finance figures — all three, as the dealership owner can.",
    "أُنشئت هذه الصفقة قبل تسجيل نسبة الشراء لشركة التمويل، وتبقى كل صفقة خاضعة للقواعد التي أُنشئت بها. يجب تسجيل عرض السعر والنسبة التي أقرّتها شركة التمويل لهذه الصفقة معًا، على يد شخص يملك الصلاحيات الثلاث مجتمعة: تسجيل طلبات التمويل واعتمادها والاطلاع على الأرقام المالية — كما يملكها مالك المعرض.",
  ],
  ApprovedPurchaseLtvDrivesSplit: [
    "This rate divides the approved amount into the financed and unfinanced portions.",
    "هذه النسبة هي التي تقسّم المبلغ المعتمد إلى جزء مموَّل وآخر غير مموَّل.",
  ],
  RecordApprovedPurchaseAction: ["Record approved amount", "تسجيل المبلغ المعتمد"],
  /**
   * The one check standing between a typed figure and the deal's economics.
   *
   * A WARNING, never a refusal: a finance company is entitled to approve an
   * amount unlike anything the dealership put in front of it, and AutoFlow does
   * not get to overrule that. It only makes sure a person meant to type it.
   */
  // Deliberately does not name the quotation and the appraisal, though the
  // ruling's example did: the rule fires on whichever figures the deal actually
  // has, and a deal with no appraisal was being told its amount differed from
  // an appraisal that does not exist — caught in the browser, not in a test.
  // The rows below name exactly what it was compared against.
  ApprovedAmountFarFromEvidence: [
    "This amount is significantly different from the figures recorded on this deal.",
    "هذا المبلغ يختلف اختلافاً كبيراً عن الأرقام المسجَّلة على هذه الصفقة.",
  ],
  ApprovedAmountYouEntered: ["You entered", "المبلغ الذي أدخلته"],
  ApprovedAmountConfirmPrompt: [
    "Please confirm this is the amount the finance company communicated.",
    "يرجى تأكيد أن هذا هو المبلغ الذي أبلغتك به شركة التمويل.",
  ],
  ApprovedAmountConfirmAction: ["Yes, record this amount", "نعم، سجِّل هذا المبلغ"],
  GoBack: ["Go back", "رجوع"],
  QuotationNeededFirst: ["Record the submitted quotation first.", "سجِّل عرض السعر المُرسَل أولاً."],
  ApprovedPurchaseNeedsApprover: [
    "A manager records this. You do not have permission to record what the finance company approved.",
    "يسجّله المدير. لا تملك صلاحية تسجيل ما اعتمدته شركة التمويل.",
  ],
  ApprovedPurchaseNotOwnDeal: [
    "You cannot record the approved amount on your own deal. A manager or the dealership owner records it.",
    "لا يمكنك تسجيل المبلغ المعتمد على صفقتك أنت. يسجّله المدير أو مالك المعرض.",
  ],
  FinanceDecisionClosed: [
    "This deal is closed. Its recorded figures can no longer be changed.",
    "هذه الصفقة مغلقة، ولم يعد بالإمكان تعديل أرقامها المسجّلة.",
  ],
  CorrectApprovedPurchaseAction: ["Correct approved amount", "تصحيح المبلغ المعتمد"],
  /**
   * Shown to an approver on a deal whose amount is recorded and whose vehicle
   * has gone out. `reopenApproval` refuses there, and it names the remedy.
   */
  ApprovedPurchaseSealedByHandover: [
    "The vehicle has already been handed over, so the approved amount can no longer be corrected. If it is wrong, the deal has to be cancelled and re-entered.",
    "تم تسليم المركبة، ولم يعد بالإمكان تصحيح المبلغ المعتمد. إذا كان المبلغ خاطئاً فيجب إلغاء الصفقة وإعادة إدخالها.",
  ],
  ReopenApprovedPurchaseTitle: ["Correct the approved amount", "تصحيح المبلغ المعتمد"],
  ReopenApprovedPurchaseDesc: [
    "Only when the amount on record is not what the finance company actually approved. The figure below stays in the deal's history with your reason beside it.",
    "يُستخدم فقط عندما لا يكون المبلغ المسجَّل هو ما اعتمدته شركة التمويل فعلاً. يبقى المبلغ أدناه في سجل الصفقة مقروناً بالسبب الذي تكتبه.",
  ],
  ReopenApprovalReasonLabel: ["Why are you correcting this?", "ما سبب التصحيح؟"],
  ReopenApprovalReasonPlaceholder: [
    "e.g. entered as 150,000 by mistake; the company approved 15,000",
    "مثال: أُدخل 150,000 بالخطأ، والمبلغ الذي اعتمدته الشركة 15,000",
  ],
  ReopenApprovalReasonRequired: ["Say why the recorded amount is being corrected.", "اذكر سبب تصحيح المبلغ المسجَّل."],
  ReopenApprovalWhatHappensNext: [
    "The amount comes off the record along with the funding split worked out from it, and handover is blocked again until the correct amount is recorded.",
    "يُرفع المبلغ عن السجل مع تقسيم التمويل المحسوب منه، ويُمنع التسليم من جديد إلى أن يُسجَّل المبلغ الصحيح.",
  ],
  ReopenApprovedPurchaseAction: ["Reopen for correction", "إعادة الفتح للتصحيح"],
  // SCRUM-373 D2
  ApplyQuoteFirstPaymentNotice: [
    "This deal records the customer's first payment as 0, but the originating quote carries a down payment.",
    "الدفعة الأولى للعميل مسجَّلة صفراً في هذه الصفقة، بينما يتضمن عرض السعر الأصلي دفعة أولى.",
  ],
  ApplyQuoteFirstPaymentAction: ["Apply quote down payment", "اعتماد دفعة عرض السعر"],
  ApplyQuoteFirstPaymentTitle: ["Apply the quote's down payment", "اعتماد الدفعة الأولى من عرض السعر"],
  ApplyQuoteFirstPaymentDesc: [
    "Sets the customer's first payment to the originating quote's down payment and recalculates the funding split. It records a financing term only: no payment or receipt is created.",
    "تُسجَّل الدفعة الأولى للعميل بقيمة الدفعة الأولى في عرض السعر الأصلي، ويُعاد احتساب تقسيم التمويل. هذا شرط تمويلي فقط، ولا تُنشأ أي دفعة أو سند قبض.",
  ],
  ApplyQuoteFirstPaymentCurrent: ["Recorded now", "المسجَّل حالياً"],
  ApplyQuoteFirstPaymentNew: ["Quote down payment", "الدفعة الأولى في عرض السعر"],
  ApplyQuoteFirstPaymentReasonLabel: ["Reason", "السبب"],
  ApplyQuoteFirstPaymentReasonRequired: [
    "Say why the first payment is being corrected.",
    "اذكر سبب تصحيح الدفعة الأولى.",
  ],
  ApplyQuoteFirstPaymentApplied: ["The first payment was updated.", "تم تحديث الدفعة الأولى."],
  DeliveredLenderTitle: ["Finance company correction", "تصحيح جهة التمويل"],
  DeliveredIdentityTitle: ["Buyer or vehicle correction", "تصحيح العميل أو المركبة"],
  DeliveredIdentityReason: ["Reason for correcting the buyer or vehicle", "سبب تصحيح العميل أو المركبة"],
  DeliveredIdentityBlocked: [
    "Review the existing payment and vehicle commitment records before replacing the buyer or vehicle.",
    "راجع سجلات الدفعات والتزامات المركبة قبل استبدال العميل أو المركبة.",
  ],
  DeliveredIdentityBuyer: ["Change buyer", "تغيير العميل"],
  DeliveredIdentityVehicle: ["Change vehicle", "تغيير المركبة"],
  DeliveredIdentityQuote: ["Replacement quote", "عرض السعر البديل"],
  DeliveredIdentityNoQuote: ["No eligible accepted quote on this page.", "لا يوجد عرض سعر مقبول ومؤهل في هذه الصفحة."],
  DeliveredIdentityNewerQuotes: ["Newer quotes", "العروض الأحدث"],
  DeliveredIdentityRequest: ["Request correction", "طلب التصحيح"],
  DeliveredIdentityApprove: ["Verify return and approve", "التحقق من الإعادة واعتماد التصحيح"],
  DeliveredIdentityWithdraw: ["Withdraw correction", "سحب طلب التصحيح"],
});

const deliveredIdentityMessages = defineBilingualMessages({
  DeliveredIdentityPending: [
    "Closing is on hold while the correction is reviewed.",
    "إغلاق الصفقة معلّق حتى مراجعة التصحيح.",
  ],
  DeliveredIdentityOriginalHandover: ["Original handover", "التسليم الأصلي"],
  DeliveredIdentityReturnTime: ["Actual vehicle return date and time", "تاريخ ووقت إعادة المركبة الفعلي"],
  DeliveredIdentityReference: ["Vehicle return evidence reference", "مرجع إثبات إعادة المركبة"],
  DeliveredIdentityHelp: [
    "The deal number and original handover are preserved. Approval requires a verified vehicle return, then fresh finance approval and handover.",
    "يُحفظ رقم الصفقة وسجل التسليم الأصلي. يتطلب الاعتماد التحقق من إعادة المركبة، ثم اعتماد التمويل وتوثيق التسليم مجدداً.",
  ],
  DeliveredIdentityWithdrawHelp: [
    "Withdrawing the request keeps the existing agreement and original handover.",
    "يبقى الاتفاق الحالي وسجل التسليم الأصلي عند سحب الطلب.",
  ],
});

const preHandoverIdentityMessages = defineBilingualMessages({
  IdentityBeforeHandoverApply: ["Apply correction", "تطبيق التصحيح"],
  IdentityBeforeHandoverHelp: [
    "This keeps the deal number and archives the previous documents. Fresh documents and finance approval are required before handover.",
    "يبقى رقم الصفقة كما هو وتُؤرشف المستندات السابقة. يلزم تقديم مستندات جديدة وإعادة اعتماد التمويل قبل التسليم.",
  ],
  IdentityBeforeHandoverLenderHelp: [
    "Confirm that the finance company withdrew the previous terms. The deal number stays the same. New documents and approvals are required before handover.",
    "أكّد أن جهة التمويل ألغت الشروط السابقة. يبقى رقم الصفقة كما هو، ويلزم تقديم مستندات واعتمادات جديدة قبل التسليم.",
  ],
  IdentityBeforeHandoverLenderReference: ["Finance company confirmation reference", "مرجع تأكيد جهة التمويل"],
  IdentityBeforeHandoverRefundHelp: [
    "For this correction, verify that the finance company returned the full amount shown on the original receipt.",
    "لتطبيق هذا التصحيح، تحقّق من أن جهة التمويل أعادت كامل المبلغ المبيّن في الإيصال الأصلي.",
  ],
  IdentityBeforeHandoverRefundEvidence: ["Original receipt and lender refund evidence", "الإيصال الأصلي وإثبات الاسترداد من جهة التمويل"],
  IdentityBeforeHandoverRefundReference: ["Lender refund confirmation reference", "مرجع تأكيد الاسترداد من جهة التمويل"],
  IdentityBeforeHandoverRefundReferenceRequired: ["Enter the lender’s refund reference.", "أدخل مرجع الاسترداد لدى جهة التمويل."],
  IdentityBeforeHandoverRefundTime: ["Actual refund date and time", "تاريخ ووقت الاسترداد الفعلي"],
  IdentityBeforeHandoverShowroomRefundRecorded: ["Showroom cash refund recorded", "تم تسجيل رد المبلغ نقداً من المعرض"],
  ServerError_LENDER_REFUND_TIME: [
    "Enter the actual refund date and time, between the original receipt and now.",
    "أدخل تاريخ ووقت الاسترداد الفعلي بين وقت الإيصال الأصلي والوقت الحالي.",
  ],
  IdentityBeforeHandoverRefundVerify: [
    "I verified the lender’s evidence links the original receipt to a full refund to the same payer.",
    "تحقّقت من أن إثبات جهة التمويل يربط الإيصال الأصلي بإعادة المبلغ كاملاً إلى الشخص الذي دفعه.",
  ],
  IdentityBeforeHandoverError: [
    "The correction could not be saved. Check the selected quote and current deal records, then try again.",
    "تعذر حفظ التصحيح. راجع عرض السعر المحدد وبيانات الصفقة الحالية ثم حاول مرة أخرى.",
  ],
});

const deliveredLenderMessages = defineBilingualMessages({
  DeliveredIdentityError: [
    "The correction could not be saved. Check the selected quote, actual return time and deal records, then try again.",
    "تعذّر حفظ التصحيح. راجع عرض السعر ووقت الإعادة الفعلي وسجلات الصفقة، ثم حاول مرة أخرى.",
  ],
  DeliveredLenderDescription: [
    "Keep the deal number and original handover. Finance must approve the new agreement before the deal can close.",
    "يبقى رقم الصفقة وسجل التسليم الأصلي محفوظين. يجب على قسم المالية اعتماد الاتفاق الجديد قبل إغلاق الصفقة.",
  ],
  DeliveredLenderQuoteNeeded: [
    "Prepare and accept a quote from the replacement lender for the same customer and vehicle with no first payment.",
    "جهّز عرضاً معتمداً من جهة التمويل البديلة للعميل والمركبة نفسيهما، من دون دفعة أولى.",
  ],
  DeliveredLenderMoneyBlocked: [
    "Finance must review the recorded payments, custody, fees or settlement activity before the lender can change.",
    "على قسم المالية مراجعة المدفوعات أو العهدة أو الرسوم أو التسوية المسجّلة قبل تغيير جهة التمويل.",
  ],
  DeliveredLenderCommitmentBlocked: [
    "Finance must verify the current vehicle commitment before the lender can change.",
    "على قسم المالية التحقق من حجز المركبة للصفقة الحالية قبل تغيير جهة التمويل.",
  ],
  DeliveredLenderRequest: ["Request lender change", "طلب تغيير جهة التمويل"],
  DeliveredLenderApprove: ["Approve lender change", "اعتماد تغيير جهة التمويل"],
  DeliveredLenderWithdraw: ["Withdraw request", "سحب الطلب"],
  DeliveredLenderWithdrawDetails: [
    "Withdrawing the request restores the original agreement for closing.",
    "يعيد سحب الطلب العمل باتفاق التمويل الأصلي لإغلاق الصفقة.",
  ],
  DeliveredLenderPending: [
    "Closing is on hold until finance reviews or withdraws this request.",
    "إغلاق الصفقة معلّق حتى مراجعة الطلب أو سحبه.",
  ],
  DeliveredLenderQuoteLabel: ["Replacement quote", "عرض التمويل البديل"],
  DeliveredLenderPreviousQuotes: ["Newer quotes", "العروض الأحدث"],
  DeliveredLenderOlderQuotes: ["Older quotes", "العروض الأقدم"],
  DeliveredLenderMonths: ["months", "أشهر"],
  DeliveredLenderReference: ["New lender’s confirmation reference", "مرجع تأكيد جهة التمويل الجديدة"],
  DeliveredLenderReason: ["Reason for changing the lender", "سبب تغيير جهة التمويل"],
  DeliveredLenderError: [
    "The lender correction could not be saved. Review the current deal and try again.",
    "تعذّر حفظ تصحيح جهة التمويل. راجع الصفقة وحاول مرة أخرى.",
  ],
});

const lenderEvidenceMessages = defineBilingualMessages({
  DerivedEconomicsHeading: ["What that leaves", "ما ينتج عن ذلك"],
  DerivedEconomicsNote: [
    "Worked out by AutoFlow from the two figures above. Not editable.",
    "يحتسبه أوتوفلو من الرقمين أعلاه، وغير قابل للتعديل.",
  ],
  DerivedFundedPortion: ["Funded by the finance company", "الجزء المموَّل من شركة التمويل"],
  DerivedUnfinancedPortion: ["Not financed", "الجزء غير المموَّل"],
  DerivedDealerContribution: ["Dealership contribution", "مساهمة المعرض"],
  DerivedCustomerToFinanceCompany: [
    "Customer payment to the finance company (confirmed)",
    "دفعة العميل إلى شركة التمويل (مؤكَّدة)",
  ],
  DerivedAppliedLtv: ["Applied LTV", "نسبة التمويل المطبَّقة"],
  RecordQuotationTitle: ["Record the quotation we submitted", "تسجيل عرض السعر المُرسَل"],
  RecordQuotationDesc: [
    "The amount the dealership sent the finance company. Recorded as it was sent — not as anyone hopes it will come back.",
    "المبلغ الذي أرسله المعرض إلى شركة التمويل. يُسجَّل كما أُرسل، لا كما هو متوقَّع أن يعود.",
  ],
  QuotationAmountLabel: ["Quotation amount", "مبلغ عرض السعر"],
  QuotationCalculatedLabel: ["AutoFlow calculates", "احتساب أوتوفلو"],
  QuotationUseCalculated: ["Use this figure", "استخدام هذا الرقم"],
  QuotationCalculatorUnavailable: [
    "AutoFlow cannot calculate a figure for this deal, so record the amount that was actually sent.",
    "لا يستطيع أوتوفلو احتساب رقم لهذه الصفقة، فسجِّل المبلغ الذي أُرسل فعلياً.",
  ],
  QuotationCalculatorLoading: [
    "Checking whether AutoFlow can calculate a figure…",
    "جارٍ التحقق من إمكانية احتساب رقم…",
  ],
  QuotationMatchesCalculation: ["Matches AutoFlow's calculation.", "مطابق لاحتساب أوتوفلو."],
  QuotationDiffersFromCalculation: ["Differs from AutoFlow's calculation.", "يختلف عن احتساب أوتوفلو."],
  QuotationOverrideReasonLabel: ["Why the amount sent differs", "سبب اختلاف المبلغ المُرسَل"],
  QuotationOverrideReasonPlaceholder: [
    "e.g. agreed by phone with the branch manager",
    "مثال: اتُّفق عليه هاتفياً مع مدير الفرع",
  ],
  QuotationOverrideReasonRequired: [
    "Say why the amount sent differs from the calculated figure.",
    "وضِّح سبب اختلاف المبلغ المُرسَل عن الرقم المحتسَب.",
  ],
  QuotationAmountInvalid: ["Enter an amount greater than zero.", "أدخل مبلغاً أكبر من صفر."],
  AmountTooPrecise: [
    "This currency does not have that many decimal places — check the amount.",
    "هذه العملة لا تحتمل هذا العدد من الخانات العشرية — راجع المبلغ.",
  ],
  QuotationRecorded: ["Quotation recorded", "تم تسجيل عرض السعر"],
  TheirAppraisalLabel: ["Recorded appraisal of the vehicle", "التخمين المسجَّل للمركبة"],
  RecordAppraisalAction: ["Record appraisal", "تسجيل التخمين"],
  AppraisalNeedsReviewer: [
    "A manager records the appraisal. The deal's stage rail waits on it once the quotation has gone out.",
    "يسجّل التخمين المدير. تتوقّف مراحل الصفقة عنده بعد إرسال عرض السعر.",
  ],
  /**
   * Shown once the vehicle has gone out with no appraisal on file.
   *
   * `recordAppraisal` refuses after handover, so the action is withdrawn — and
   * the stage rail still asks for the appraisal, which reads as a dead end
   * unless the screen says where the deal actually goes from here.
   */
  AppraisalClosedByHandover: [
    "The vehicle has already been handed over, so an appraisal can no longer be recorded against this deal. A manager records the amount the finance company approved instead, choosing \"another amount they named\" and saying what they told the dealership.",
    "سُلِّمت المركبة فعلاً، ولم يعد بالإمكان تسجيل تخمين على هذه الصفقة. يسجّل المدير بدلاً من ذلك المبلغ الذي اعتمدته شركة التمويل، باختيار «مبلغ آخر حدّدته» مع ذكر ما أبلغت به المعرض.",
  ],
  RecordAppraisalTitle: ["Record the appraisal on this vehicle", "تسجيل تخمين المركبة"],
  RecordAppraisalDesc: [
    "What the vehicle was valued at, and by whom. Sending the quotation puts the appraisal in play, so the deal waits here until it is recorded.",
    "القيمة التي قُدِّرت بها المركبة، ومن قدّرها. إرسال عرض السعر يُدخِل التخمين في المسار، وتنتظر الصفقة عنده حتى يُسجَّل.",
  ],
  AppraisalAmountLabel: ["Appraised value", "القيمة المُخمَّنة"],
  AppraisalAmountInvalid: ["Enter an amount greater than zero.", "أدخل مبلغاً أكبر من صفر."],
  AppraisalProviderLabel: ["Who appraised it", "جهة التخمين"],
  AppraisalByFinanceCompany: ["The finance company", "شركة التمويل"],
  AppraisalByIndependent: ["An independent appraiser", "مُخمِّن مستقل"],
  AppraisalProviderNameLabel: ["Appraiser name", "اسم المُخمِّن"],
  AppraisalDateLabel: ["Date appraised", "تاريخ التخمين"],
  AppraisalRecorded: ["Appraisal recorded", "تم تسجيل التخمين"],
  ReplaceAppraisalAction: ["Replace appraisal", "استبدال التخمين"],
  ReplaceAppraisalTitle: ["Replace the appraisal on this vehicle", "استبدال تخمين المركبة"],
  ReplaceAppraisalDesc: [
    "A second valuation supersedes the one on file. Record what it was valued at, by whom, and why it was appraised again.",
    "التخمين الثاني يحل محل المسجَّل حالياً. سجِّل القيمة الجديدة ومن قدّرها وسبب إعادة التخمين.",
  ],
  ReappraisalReasonLabel: ["Why the vehicle was appraised again", "سبب إعادة تخمين المركبة"],
  ReappraisalReasonPlaceholder: ["e.g. the first figure was entered wrongly", "مثال: أُدخل الرقم الأول بشكل خاطئ"],
  ReappraisalReasonRequired: ["Say why a second appraisal was requested.", "وضِّح سبب طلب تخمين ثانٍ."],
  ReappraisalSupersedes: [
    "This replaces the appraisal of {amount} currently on file.",
    "يحل هذا محل التخمين المسجَّل حالياً بمبلغ {amount}.",
  ],
  ReappraisalReopensApproval: [
    "The approved purchase amount was based on it, so recording this withdraws that approval and it will have to be recorded again.",
    "المبلغ المعتمد كان مبنياً عليه، لذا يؤدي تسجيل هذا إلى سحب ذلك الاعتماد وسيلزم تسجيله من جديد.",
  ],
  AppraisalWithdrawsApproval: [
    "This deal already has an approved purchase amount recorded without an appraisal. Recording one now withdraws that approval, and the finance company's amount will have to be recorded again.",
    "لهذه الصفقة مبلغ معتمد مسجَّل بدون تخمين. تسجيل تخمين الآن يسحب ذلك الاعتماد، وسيلزم تسجيل مبلغ شركة التمويل من جديد.",
  ],
  RecordApprovedPurchaseTitle: ["Record what the finance company approved", "تسجيل ما اعتمدته شركة التمويل"],
  CorrectDeliveredApprovalAction: ["Correct approved amount after delivery", "تصحيح المبلغ المعتمد بعد التسليم"],
  CorrectDeliveredApprovalDesc: [
    "Enter the corrected amount from the finance company. The original handover stays on this deal and its first-payment evidence is checked again.",
    "أدخل المبلغ المصحح الذي أكدته شركة التمويل. يُحفظ سجل التسليم الأصلي على الصفقة ويُعاد التحقق من إثبات الدفعة الأولى.",
  ],
  CurrentApprovedAmountLabel: ["Current approved amount", "المبلغ المعتمد الحالي"],
  DeliveredApprovalReferenceLabel: ["Finance company confirmation reference", "مرجع تأكيد شركة التمويل"],
  RecordApprovedPurchaseDesc: [
    "The amount the finance company said it will buy the vehicle at. Recording it here puts their decision on the record; it does not make one.",
    "المبلغ الذي أبلغت شركة التمويل أنها ستشتري به المركبة. تسجيله هنا يوثّق قرارها، ولا يصنع قراراً.",
  ],
  ApprovedAmountLabel: ["Approved amount", "المبلغ المعتمد"],
  ApprovalBasisLabel: ["What they based it on", "أساس الاعتماد"],
  BasisAppraisal: ["The recorded appraisal", "التخمين المسجَّل"],
  BasisAppraisalHint: ["Equal to the appraisal on file.", "مساوٍ للتخمين المسجَّل على الصفقة."],
  BasisQuotationException: ["Our quotation, as an exception", "عرض السعر المُرسَل، استثناءً"],
  BasisQuotationExceptionHint: [
    "They approved at the amount we submitted even though the recorded appraisal is lower. Their own tolerance rule decides whether this is allowed.",
    "اعتمدت المبلغ الذي أرسلناه رغم أن التخمين المسجَّل أقل. قاعدة التفاوت لديها هي التي تحدّد ما إذا كان ذلك مسموحاً.",
  ],
  BasisManual: ["Another amount they named", "مبلغ آخر حدّدته"],
  BasisManualNotesLabel: ["What they told us", "ما أبلغتنا به"],
  BasisManualNotesPlaceholder: [
    "e.g. approved at 18,900 by the branch's credit officer",
    "مثال: اعتُمد بمبلغ 18,900 من ضابط الائتمان في الفرع",
  ],
  BasisManualNotesRequired: [
    "Record what the finance company said. It is kept on the audit record.",
    "سجِّل ما أبلغت به شركة التمويل. يُحفظ في سجل التدقيق.",
  ],
  NoAppraisalOnFile: [
    "No appraisal is recorded on this deal, so only an amount they named directly can be recorded.",
    "لا يوجد تخمين مسجَّل على هذه الصفقة، لذلك يمكن تسجيل المبلغ الذي حدّدته مباشرة فقط.",
  ],
  ApprovedAmountInvalid: ["Enter an amount greater than zero.", "أدخل مبلغاً أكبر من صفر."],
  ApprovedPurchaseRecorded: ["Approved amount recorded", "تم تسجيل المبلغ المعتمد"],
  ApprovedPurchaseReopened: [
    "Reopened for correction — record the correct amount",
    "أُعيد الفتح للتصحيح — سجِّل المبلغ الصحيح",
  ],
});

// Before-handover identity messages have different positions in the two catalogs.
export const lenderDecisionEn = {
  ...financeDecisionMessages.en,
  ...deliveredIdentityMessages.en,
  ...preHandoverIdentityMessages.en,
  ...deliveredLenderMessages.en,
};

export const lenderEvidenceEn = lenderEvidenceMessages.en;

export const lenderDecisionAr = {
  ...financeDecisionMessages.ar,
  ...preHandoverIdentityMessages.ar,
  ...deliveredIdentityMessages.ar,
  ...deliveredLenderMessages.ar,
};

export const lenderEvidenceAr = lenderEvidenceMessages.ar;
