import { defineBilingualMessages } from "../../defineBilingualMessages";

export const closingReadinessMessages = defineBilingualMessages({
  /** Legal invoice & deal closing bindings. */
  RecordLegalInvoice: ["Record Legal Invoice", "تسجيل الفاتورة القانونية"],
  RecordLegalInvoiceDesc: [
    "Optional. Record a legal invoice only if one was really issued, exactly as printed. It is checked against the deal and kept as evidence; it never sets the sale revenue or its date.",
    "اختياري. سجّل فاتورة قانونية فقط إن صدرت فعلًا، كما هي مطبوعة. تُراجَع مقابل الصفقة وتُحفظ كدليل؛ ولا تحدّد إيراد البيع ولا تاريخه.",
  ],
  LegalInvoiceIssuerName: ["Issued by (importer / supplier name)", "صادرة عن (اسم المستورد / المورّد)"],
  LegalInvoiceIssuerHintConsigned: [
    "This car belongs to a supplier or importer, so the vehicle invoice to the finance company is theirs. The dealership issues none for its margin.",
    "هذه السيارة مملوكة لمورّد أو مستورد، لذا فاتورة السيارة إلى شركة التمويل صادرة عنه. المعرض لا يصدر فاتورة عن هامشه.",
  ],
  LegalInvoiceAmountHint: [
    "The finance company's invoice is for the approved amount only; the customer's own gap is not on it.",
    "فاتورة شركة التمويل بمبلغ الموافقة فقط؛ فجوة العميل الخاصة ليست فيها.",
  ],
  LegalInvoiceAmount: ["Invoice amount", "مبلغ الفاتورة"],
  LegalInvoiceNumber: ["Invoice number", "رقم الفاتورة"],
  LegalInvoiceDate: ["Invoice date", "تاريخ الفاتورة"],
  LegalInvoiceDateNotOpenYet: [
    "Today's date opens on the ledger at {time} (midnight UTC). Pick the date printed on the invoice; if it is today, save the invoice after that time.",
    "يبدأ تاريخ اليوم في الدفاتر الساعة {time} (منتصف الليل بتوقيت UTC). اختر التاريخ المطبوع على الفاتورة، وإن كان تاريخ اليوم فاحفظ الفاتورة بعد ذلك الوقت.",
  ],
  LegalInvoiceIssuedTo: ["Issued to", "صادرة إلى"],
  LegalInvoiceIssuedToOther: ["Specify recipient", "تحديد المستلم"],
  SubmitLegalInvoice: ["Save Legal Invoice", "حفظ الفاتورة القانونية"],
  LegalInvoiceRecorded: ["Legal invoice saved", "تم حفظ الفاتورة القانونية"],
  ReconcileDealFee: ["Reconcile fee", "تسوية الرسم"],
  ReconcileFeeNote: [
    "Record what was checked before reconciling this cost.",
    "سجّل ما تم التحقق منه قبل تسوية هذا المصروف.",
  ],
  ReconcileNotes: ["Verification notes", "ملاحظات التحقق"],
  ReconcileNotesPlaceholder: ["e.g. Verified against ministry receipt #12345", "مثال: تم التحقق من وصل الوزارة رقم 12345"],
  ReconcileNotesRequired: ["Record what was checked before reconciling this cost.", "سجّل ما تم التحقق منه قبل تسوية هذا المصروف."],
  ConfirmReconcile: ["Confirm reconciliation", "تأكيد التسوية"],
  ReconcileVarianceOver: ["Actual is higher than expected by", "الفعلي أعلى من المتوقّع بمقدار"],
  ReconcileVarianceUnder: ["Actual is lower than expected by", "الفعلي أقل من المتوقّع بمقدار"],
  ReconcileVarianceNone: ["Actual matches the expected amount", "الفعلي يطابق المبلغ المتوقّع"],
  ReconcileVarianceNotesHint: [
    "The actual differs from the expected amount. Say what you checked and why it differs (receipt number, company letter).",
    "الفعلي يختلف عن المتوقّع. اذكر ما تحققت منه وسبب الاختلاف (رقم الإيصال، كتاب الشركة).",
  ],
  ReconcileAmountChanged: [
    "The recorded amount changed while this form was open. Cancel and reopen it to check the current figure.",
    "تغيّر المبلغ المسجّل أثناء فتح هذا النموذج. ألغِ وأعد فتحه لمراجعة المبلغ الحالي.",
  ],
  ReconcileEvidenceChanged: [
    "The receipt, paid date or attachments were re-recorded while this form was open. Cancel and reopen it to check the current evidence.",
    "أُعيد تسجيل الإيصال أو تاريخ الدفع أو المرفقات أثناء فتح هذا النموذج. ألغِ وأعد فتحه لمراجعة الأدلة الحالية.",
  ],
  ExecutionFeeCorrectAmount: ["Correct amount", "تصحيح المبلغ"],
  HandoverCostReconciled: ["Cost reconciled", "تمت تسوية المصروف"],
  LegalInvoiceNotRecorded: ["No legal invoice recorded yet.", "لم يتم تسجيل فاتورة قانونية بعد."],
  // SCRUM-407 — the automatic closing readiness that replaced manual classification.
  ClosingReadinessHeading: ["Closing readiness & legal invoice", "جاهزية إغلاق الصفقة والفاتورة القانونية"],
  ClosingReadinessAuto: [
    "Checked automatically from this deal's records, and checked again when it is closed.",
    "تُفحص تلقائيًا من سجلات هذه الصفقة، ويُعاد فحصها عند إغلاقها.",
  ],
  ClosingReadinessStateReady: ["Ready to close", "جاهزة للإغلاق"],
  ClosingReadinessStateBlocked: ["Not ready to close", "غير جاهزة للإغلاق"],
  ClosingReadinessStateUnavailable: ["Readiness could not be checked", "تعذّر فحص الجاهزية"],
  ClosingReadinessLoading: ["Checking readiness…", "جارٍ فحص الجاهزية…"],
  ClosingReadinessServiceUnavailable: [
    "Readiness is unavailable right now. Everything else on this deal still works; closing waits until readiness can be checked.",
    "الجاهزية غير متاحة حاليًا. تبقى بقية إجراءات الصفقة متاحة، أما الإغلاق فينتظر إلى أن يتسنّى فحصها.",
  ],
  ClosingReadinessClosed: ["This deal is no longer open to be closed.", "لم تعد هذه الصفقة مفتوحة للإغلاق."],
  ClosingReadinessNoChecks: [
    "The checks could not be run on this deal's records. Closing will refuse until they can.",
    "تعذّر إجراء الفحوص على سجلات هذه الصفقة، وسيُرفض الإغلاق حتى يمكن إجراؤها.",
  ],
  ClosingCheckReady: ["Ready", "جاهز"],
  ClosingCheckBlocked: ["Needs action", "يحتاج إجراء"],
  ClosingCheckUnavailable: ["Cannot be checked", "تعذّر الفحص"],
  ClosingCheckNotApplicable: ["Not needed on this deal", "غير مطلوب في هذه الصفقة"],
  ClosingCheck_DEAL_MODE_RETIRED: ["The deal is a cash or finance-company deal", "الصفقة نقدية أو عبر شركة تمويل"],
  ClosingCheck_REMITTANCE_KNOWN: ["What the finance company remits is established", "المبلغ الذي تحوّله شركة التمويل محدَّد"],
  ClosingCheck_CONFIGURED_FEES_RECORDED: ["Every fee the finance company configures is recorded", "كل رسم تضبطه شركة التمويل مسجَّل"],
  ClosingCheck_CUSTODY_ON_LEDGER: ["Employee custody is on the books", "عهدة الموظفين مرحَّلة إلى الدفاتر"],
  ClosingCheck_CUSTODY_SETTLED: ["Employee custody is settled", "عهدة الموظفين مسوّاة"],
  ClosingCheck_COSTS_CLOSABLE: ["Deal costs are recorded and reconciled", "مصاريف الصفقة مسجَّلة ومسوّاة"],
  ClosingCheck_HANDOVER_COSTS_PAID: ["Handover costs are paid", "مصاريف التسليم مدفوعة"],
  // SCRUM-629 F-22: the AGREED amount is known — not that the money was received (SCRUM-635).
  ClosingCheck_FIRST_PAYMENT_RECORDED: ["The agreed first payment is known", "الدفعة الأولى المتفق عليها معروفة"],
  ClosingCheck_FIRST_PAYMENT_RECEIVED: ["The first payment is verified", "تم التحقق من استلام الدفعة الأولى"],
  ClosingReason_FIRST_PAYMENT_PROOF_MISSING: [
    "Verify the customer's agreed first payment before handing over the vehicle.",
    "تحقّق من استلام الدفعة الأولى المتفق عليها قبل تسليم المركبة.",
  ],
  ClosingReason_FIRST_PAYMENT_PROOF_UNAVAILABLE: [
    "The first-payment evidence cannot be verified. Ask the finance team to review the receipts.",
    "تعذّر التحقق من إثبات الدفعة الأولى. اطلب من فريق المالية مراجعة الإيصالات.",
  ],
  ClosingReason_WITHHELD_FIRST_PAYMENT_RECEIVED: [
    "Ask the finance team to verify the first payment.",
    "اطلب من فريق المالية التحقق من الدفعة الأولى.",
  ],
  FirstPaymentProofTitle: ["First-payment evidence", "إثبات استلام الدفعة الأولى"],
  FirstPaymentProofAgreed: ["Agreed first payment", "الدفعة الأولى المتفق عليها"],
  FirstPaymentProofDealerReceived: ["Received by the dealership", "المبلغ المستلم لدى المعرض"],
  FirstPaymentProofDirectConfirmed: ["Confirmed by the finance company", "المبلغ المؤكّد من جهة التمويل"],
  FirstPaymentProofNeeded: ["Verify the remaining amount before vehicle handover.", "تحقّق من المبلغ المتبقي قبل تسليم المركبة."],
  FirstPaymentProofPriorNote: ["Confirmations for earlier deal details are kept for reference and excluded from the total.", "تُحفظ التأكيدات المرتبطة ببيانات سابقة للصفقة للرجوع إليها، ولا تُحتسب ضمن الإجمالي."],
  FirstPaymentProofSource: ["Evidence from the finance company", "الإثبات الصادر من جهة التمويل"],
  FirstPaymentProofReceipt: ["Receipt", "إيصال"],
  FirstPaymentProofConfirmation: ["Confirmation", "تأكيد"],
  FirstPaymentProofDialogDescription: [
    "Record the amount, date, and reference on the receipt or confirmation issued by the finance company.",
    "سجّل المبلغ والتاريخ والرقم المرجعي الواردة في الإيصال أو التأكيد الصادر من جهة التمويل.",
  ],
  FirstPaymentProofVoidDescription: [
    "The confirmation stays in the history. Its amount is removed from the verified total. If the vehicle was handed over and the remaining evidence is insufficient, closing is blocked. Use the deal cancellation process.",
    "يبقى التأكيد في السجل، لكن مبلغه لا يُحتسب. إذا سُلّمت المركبة ولم يكفِ الإثبات المتبقي، يتعذّر إغلاق الصفقة. استخدم إجراءات إلغاء الصفقة.",
  ],
  ClosingCheck_LEGAL_INVOICE_RECORDED: ["The legal invoice (optional) agrees with the deal", "الفاتورة القانونية (اختيارية) تطابق الصفقة"],
  ClosingCheck_RECOGNITION_PERIOD_OPEN: ["The handover date falls in an open accounting period", "تاريخ التسليم يقع في فترة محاسبية مفتوحة"],
  // SCRUM-420 — generic fallback for a check this bundle has no copy for (S420-01).
  ClosingCheck_UNKNOWN: ["Another closing check", "شرط إغلاق آخر"],
  ClosingReason_UNKNOWN: [
    "This check isn't met yet, so the deal can't be finalized.",
    "هذا الشرط لم يتحقق بعد، لذا لا يمكن إغلاق الصفقة.",
  ],
  ClosingCheck_FINANCING_RECONCILED: ["The financing figures have been reviewed", "تمت مراجعة أرقام التمويل"],
  ClosingCheck_CUSTOMER_FINANCE_COMPANY_PAYMENT_CONFIRMED: [
    "The customer's payment to the finance company is confirmed",
    "دفعة العميل إلى شركة التمويل مؤكَّدة",
  ],
  // SCRUM-414 — why a check is not met, by the server's reason code (lib/closingReadinessReasonCodes.ts).
  ClosingReason_REMITTANCE_APPROVAL_MISSING: [
    "The finance company's approved purchase amount is not recorded yet, so what it will remit is not known. Record the approval before closing.",
    "لم يُسجَّل بعد مبلغ الشراء الذي اعتمدته شركة التمويل، لذلك لا يُعرف ما ستحوّله إلى المعرض. سجِّل الاعتماد قبل الإغلاق.",
  ],
  ClosingReason_REMITTANCE_UNKNOWN: [
    "What the finance company will actually remit is not known on this deal. Resolve its reconciliation note before closing.",
    "المبلغ الذي ستحوّله شركة التمويل فعليًا غير معروف في هذه الصفقة. عالِج ملاحظة المطابقة عليها قبل الإغلاق.",
  ],
  ClosingReason_DEAL_ROWS_TOO_MANY_COST_LINES: [
    "This deal has more than {max} live cost lines, more than one check can verify. Remove the lines that should not be there.",
    "على هذه الصفقة أكثر من {max} بند مصروف قائم، وهذا أكثر مما يمكن التحقق منه دفعة واحدة. احذف البنود التي لا ينبغي وجودها.",
  ],
  ClosingReason_DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS: [
    "This deal carries more than {max} custody records, more than can be checked completely. Have the deal's custody reviewed.",
    "على هذه الصفقة أكثر من {max} سجل عهدة، وهذا أكثر مما يمكن فحصه كاملًا. اطلب مراجعة عهدة الصفقة.",
  ],
  ClosingReason_CONFIGURED_FEES_POLICY_OVER_CAPACITY: [
    "The finance company's frozen policy configures {templateCount} fees, more than the {max} cost lines a deal can carry. Correct the company's fee templates and re-create the application.",
    "تضبط سياسة شركة التمويل المثبّتة على هذه الصفقة {templateCount} رسمًا، وهذا يتجاوز الحد الأقصى البالغ {max} بند مصروف للصفقة. صحّح قوالب رسوم الشركة وأعد إنشاء الطلب.",
  ],
  ClosingReason_CONFIGURED_FEES_MISSING: [
    "{count} fee(s) configured by the finance company have no actual amount recorded. Record what was paid for each — zero if it was not charged.",
    "يوجد {count} من الرسوم التي تضبطها شركة التمويل دون مبلغ فعلي مسجَّل. سجِّل ما دُفع فعلًا لكل منها، أو صفرًا إن لم يُحتسب.",
  ],
  ClosingReason_CUSTODY_NOT_ON_LEDGER: [
    "A custody movement or custody-paid cost on this deal is not fully posted to the books yet. Wait for the posting to complete, or have the record reviewed.",
    "توجد حركة عهدة أو مصروف مدفوع من العهدة على هذه الصفقة لم يُرحَّل بالكامل إلى الدفاتر بعد. انتظر اكتمال الترحيل أو اطلب مراجعة السجل.",
  ],
  ClosingReason_CUSTODY_LEDGER_UNVERIFIABLE: [
    "Whether this deal's custody is on the books could not be verified. Have the deal's custody reviewed.",
    "تعذّر التحقق من ترحيل عهدة هذه الصفقة إلى الدفاتر. اطلب مراجعة عهدة الصفقة.",
  ],
  ClosingReason_CUSTODY_OPEN: [
    "A custody record on this deal is still open. Settle what that person holds or is owed before closing.",
    "يوجد سجل عهدة مفتوح على هذه الصفقة. سوِّ ما بحوزة الموظف أو ما يستحقه قبل الإغلاق.",
  ],
  ClosingReason_CUSTODY_NO_LONGER_BALANCES: [
    "A closed custody record no longer balances — its costs changed after it was reconciled. Reopen and settle it before closing.",
    "سجل عهدة مغلق على هذه الصفقة لم يعد متوازنًا لأن مصاريفه تغيّرت بعد تسويته. أعد فتحه وسوِّه قبل الإغلاق.",
  ],
  ClosingReason_CUSTODY_CURRENCY_MISMATCH: [
    "A cost in {lineCurrency} is charged to a custody record in {custodyCurrency}; the two cannot be summed. Correct the line's currency or release it from custody.",
    "مصروف بعملة {lineCurrency} محمَّل على سجل عهدة بعملة {custodyCurrency}، ولا يمكن جمعهما. صحّح عملة البند أو افصله عن العهدة.",
  ],
  ClosingReason_CUSTODY_AMOUNT_UNREADABLE: [
    "A custody amount, or a cost charged to custody, is not a readable figure. Correct the record before closing.",
    "أحد مبالغ العهدة أو مصروف محمَّل عليها ليس رقمًا صالحًا. صحّح السجل قبل الإغلاق.",
  ],
  ClosingReason_COSTS_NONE: [
    "No costs are itemized on this deal. Record them — or a zero-cost line saying the dealership bore none — before closing.",
    "لا توجد مصاريف مفصّلة على هذه الصفقة. سجّلها، أو سجّل بندًا بقيمة صفر يبيّن أن المعرض لم يتحمّل أي مصروف، قبل الإغلاق.",
  ],
  CashNoCostNeedsDeclaration: ["Sales must declare that the dealership incurred no costs on this deal.", "على موظف المبيعات التصريح بأن المعرض لم يتحمّل أي مصاريف على هذه الصفقة."],
  CashNoCostAwaitingApproval: ["Declaration of no dealership costs awaiting independent approval.", "تصريح عدم تحمّل المعرض مصاريف بانتظار اعتماد مستقل."],
  CashNoCostDeclare: ["Declare no dealership costs", "التصريح بعدم تحمّل المعرض مصاريف"],
  CashNoCostConfirm: ["Confirm no dealership costs", "تأكيد عدم تحمّل المعرض مصاريف"],
  CashNoCostSaveFailed: ["The closeout could not be saved. Refresh the deal and try again.", "تعذّر حفظ إقفال المصاريف. حدّث الصفقة وحاول مجدداً."],
  CashNoCostUnavailable: ["No-cost closeout is temporarily unavailable.", "إقفال المصاريف دون تكاليف غير متاح مؤقتاً."],
  CashNoCostQueueTitle: ["Pending no-cost confirmations", "تأكيدات عدم تحمّل المصاريف المعلّقة"],
  CashNoCostQueueLoading: ["Loading no-cost confirmations…", "جارٍ تحميل تأكيدات عدم تحمّل المصاريف…"],
  CashNoCostQueueEmpty: ["No no-cost declarations are awaiting your confirmation.", "لا توجد تصريحات بعدم تحمّل مصاريف بانتظار تأكيدك."],
  CashNoCostQueueLoadFailed: ["Confirmations could not be loaded. After the deal records are corrected, reload this page.", "تعذّر تحميل التأكيدات. أعد تحميل هذه الصفحة بعد تصحيح سجلات الصفقة."],
  ClosingReason_CASH_CLOSEOUT_REQUIRED: [
    "Record and reconcile the actual dealership costs, or have an independent approver confirm that the dealership incurred none.",
    "سجّل مصاريف المعرض الفعلية وسوِّها، أو اطلب من معتمد مستقل تأكيد أن المعرض لم يتحمّل أي مصاريف.",
  ],
  ClosingReason_CASH_CLOSEOUT_ZERO_ONLY: [
    "Correct the recorded costs, or void any zero-amount placeholders and complete the no-cost declaration before finalizing.",
    "صحّح المصاريف المسجّلة، أو ألغِ البنود الصورية بقيمة صفر وأكمل التصريح بعدم وجود مصاريف قبل الإغلاق.",
  ],
  ClosingReason_CASH_COST_PAYMENT_UNVERIFIED: [
    "A dealership cost uses a type without a supported payment path. Review the cost type and record the payment before closing.",
    "أحد مصاريف المعرض مسجّل بنوع لا يدعم تسجيل الدفع. راجع نوع المصروف وسجّل الدفع قبل الإغلاق.",
  ],
  ClosingReason_COSTS_FOREIGN_CURRENCY: [
    "{count} cost line(s) on this deal are not in {currency}. Correct them before closing.",
    "يوجد {count} من بنود المصاريف على هذه الصفقة بغير عملة {currency}. صحّحها قبل الإغلاق.",
  ],
  ClosingReason_COSTS_AMOUNT_UNREADABLE: [
    "A cost amount on this deal is not a readable figure. Correct the line before closing.",
    "أحد مبالغ المصاريف على هذه الصفقة ليس رقمًا صالحًا. صحّح البند قبل الإغلاق.",
  ],
  ClosingReason_COSTS_AWAITING_ACTUAL: [
    "{count} cost(s) have no actual amount recorded. Record them before closing.",
    "يوجد {count} من المصاريف دون مبلغ فعلي مسجَّل. سجّلها قبل الإغلاق.",
  ],
  ClosingReason_COSTS_AWAITING_RECONCILIATION: [
    "{count} cost(s) have an amount nobody has checked. Reconcile them before closing.",
    "يوجد {count} من المصاريف بمبالغ لم يتحقق منها أحد. سوِّها قبل الإغلاق.",
  ],
  ClosingReason_COSTS_NOT_RECONCILED: [
    "This deal's costs are not fully reconciled.",
    "مصاريف هذه الصفقة غير مسوّاة بالكامل.",
  ],
  ClosingReason_COSTS_TREATMENT_UNMAPPED: [
    "\"{feeLabel}\" is classified as {treatment}, which has no account to post to. Reclassify it before closing.",
    "البند «{feeLabel}» مصنّف على أنه {treatment}، ولا يوجد حساب يُرحَّل إليه. أعد تصنيفه قبل الإغلاق.",
  ],
  ClosingReason_HANDOVER_COSTS_NO_ACTUAL: [
    "{count} handover cost(s) have no actual amount recorded. Record each one's actual (or zero if the dealership was charged nothing) in Handover costs before closing.",
    "يوجد {count} من مصاريف التسليم دون مبلغ فعلي مسجَّل. سجّل الفعلي لكل منها (أو صفرًا إن لم يُحمَّل المعرض شيئًا) في مصاريف التسليم قبل الإغلاق.",
  ],
  ClosingReason_HANDOVER_COSTS_UNPAID: [
    "{count} handover cost(s) have not been paid from a recorded source. In Handover costs, record the dealership's direct payment; or charge the cost to the employee custody that paid it under Employee cash custody. Then close.",
    "يوجد {count} من مصاريف التسليم لم يُسجَّل لها مصدر دفع. في مصاريف التسليم سجّل دفع المعرض المباشر، أو حمِّل المصروف على عهدة الموظف التي دفعته من قسم عهدة الموظف النقدية، ثم أغلق.",
  ],
  ClosingReason_HANDOVER_COSTS_CONFLICT: [
    "{count} handover cost(s) are recorded as paid both from employee custody and directly, which would count the cost twice. Have the line reviewed before closing.",
    "يوجد {count} من مصاريف التسليم مسجَّلة كمدفوعة من عهدة الموظف ومباشرةً معًا، مما يحسب المصروف مرتين. اطلب مراجعة البند قبل الإغلاق.",
  ],
  ClosingReason_HANDOVER_COSTS_UNSUPPORTED_TREATMENT: [
    "{count} handover cost(s) are classified with a treatment no payment can be recorded against, so they would never reach the books. In Handover costs, remove each one and add it again as an ownership transfer, insurance or selling expense; each is then settled from the employee's custody or by a direct dealership payment, as applicable. Then close.",
    "يوجد {count} من مصاريف التسليم مصنّفة بمعالجة محاسبية لا يمكن تسجيل دفع عليها، فلن تصل إلى الدفاتر أبدًا. في مصاريف التسليم احذف كل بند منها وأضفه من جديد كمصروف نقل ملكية أو تأمين أو بيع؛ وتتم تسوية كل منها من عهدة الموظف أو بدفع مباشر من المعرض بحسب الحال. ثم أغلق.",
  ],
  ClosingReason_HANDOVER_COSTS_DEDUCTION_NOT_RECOGNISED: [
    "{count} handover cost(s) are marked as deducted from the finance company's settlement, but this deal has no configured financing plan to recognise a deduction, so they would never reach the books. In Handover costs, remove each one and add it again without the settlement deduction, then pay it directly or charge it to custody. Then close.",
    "يوجد {count} من مصاريف التسليم معلَّمة كمخصومة من تسوية شركة التمويل، لكن هذه الصفقة بلا خطة تمويل مُعدّة تعترف بالخصم، فلن تصل إلى الدفاتر أبدًا. في مصاريف التسليم احذف كل بند منها وأضفه من جديد دون خصم التسوية، ثم سجّل دفعه مباشرةً أو حمِّله على العهدة. ثم أغلق.",
  ],
  ClosingReason_HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW: [
    "{count} handover cost(s) come from the finance company's older fee setup, and their accounting treatment cannot be paid or posted as recorded. They cannot be corrected from the deal. Ask an accountant or administrator to review them before finalizing.",
    "يوجد {count} من مصاريف التسليم مصدرها إعداد الرسوم القديم لشركة التمويل، ولا يمكن دفع معالجتها المحاسبية أو ترحيلها كما هي مسجّلة. ولا يمكن تصحيحها من الصفقة. اطلب من المحاسب أو المسؤول مراجعتها قبل إغلاق الصفقة.",
  ],
  ClosingReason_HANDOVER_DIRECT_NOT_ON_LEDGER: [
    "{count} direct handover payment(s) are recorded but not on the books yet: the posting is waiting because no accounting period is open for its date, or has not been processed. Open the accounting period for the payment date and let the accounting queue process, then close the deal.",
    "يوجد {count} من مدفوعات مصاريف التسليم المباشرة مسجَّلة لكنها لم تدخل الدفاتر بعد: القيد بانتظار فتح فترة محاسبية لتاريخ الدفع أو لم تتم معالجته. افتح الفترة المحاسبية لتاريخ الدفع واترك طابور المحاسبة يعالجه، ثم أغلق الصفقة.",
  ],
  ClosingReason_HANDOVER_DIRECT_REVERSAL_PENDING: [
    "{count} direct handover payment(s) that were removed, set to zero or replaced on their cost line are still on the books: their reversal is waiting because no accounting period is open for the date the payment was taken back (the day it was removed, set to zero or replaced — usually today, not the payment date). Open the accounting period that covers that date (or wait for the reversal to post), then close the deal.",
    "يوجد {count} من مدفوعات مصاريف التسليم المباشرة التي حُذفت أو صُفّرت أو استُبدلت في بند التكلفة ما زالت في الدفاتر: عكس القيد بانتظار فتح فترة محاسبية لتاريخ التراجع عن الدفع (يوم الحذف أو التصفير أو الاستبدال — غالبًا اليوم وليس تاريخ الدفع). افتح الفترة المحاسبية التي تشمل ذلك التاريخ (أو انتظر ترحيل عكس القيد)، ثم أغلق الصفقة.",
  ],
  ClosingReason_HANDOVER_DIRECT_LEDGER_UNVERIFIABLE: [
    "The ledger could not be read completely, so whether the direct handover payments are on the books cannot be confirmed. Try again shortly; if it persists, have the deal's accounting reviewed.",
    "تعذّرت قراءة الدفاتر كاملةً، فلا يمكن التأكد من دخول مدفوعات مصاريف التسليم المباشرة إليها. حاول مجدداً بعد قليل، وإن استمر ذلك فاطلب مراجعة محاسبة الصفقة.",
  ],
  ClosingReason_FIRST_PAYMENT_MISSING: [
    "The customer's first payment is not recorded, so the funding split cannot be established. Record it before closing.",
    "لم تُسجَّل الدفعة الأولى للعميل، لذلك لا يمكن تحديد توزيع التمويل. سجّلها قبل الإغلاق.",
  ],
  // SCRUM-629 F-08: a PENDING_DOCS application on a deal that needs no document.
  AppStatusSubmitted: ["Submitted", "مُقدَّم"],
  // SCRUM-629 F-22
  ClosingReason_FIRST_PAYMENT_INPUTS_PENDING: [
    "The finance company's approval must be recorded before the agreed first payment can be checked.",
    "يجب تسجيل موافقة شركة التمويل قبل التحقق من الدفعة الأولى المتفق عليها.",
  ],
  ClosingReason_LEGAL_INVOICE_MISSING: [
    "No legal invoice is recorded. Revenue is posted from its amount, so record it before closing.",
    "لا توجد فاتورة قانونية مسجَّلة. يُرحَّل الإيراد من مبلغها، لذا سجّلها قبل الإغلاق.",
  ],
  ClosingReason_LEGAL_INVOICE_UNUSABLE: [
    "The recorded legal invoice amount is not a usable figure. Record it again before closing.",
    "مبلغ الفاتورة القانونية المسجَّل ليس رقمًا صالحًا. أعد تسجيله قبل الإغلاق.",
  ],
  ClosingReason_LEGAL_INVOICE_WRONG_RECIPIENT: [
    "The finance company is the legal buyer, but the recorded invoice was not issued to it. Re-record the invoice before closing.",
    "شركة التمويل هي المشتري القانوني، لكن الفاتورة المسجَّلة لم تصدر باسمها. أعد تسجيل الفاتورة قبل الإغلاق.",
  ],
  ClosingReason_LEGAL_INVOICE_AMOUNT_MISMATCH: [
    "The recorded legal invoice does not match the finance company's approved amount. Correct it to the real document before closing.",
    "الفاتورة القانونية المسجَّلة لا تطابق المبلغ الذي اعتمدته شركة التمويل. صحّحها لتوافق المستند الحقيقي قبل الإغلاق.",
  ],
  ClosingReason_LEGAL_INVOICE_WRONG_ISSUER: [
    "The recorded invoice's issuer does not fit this car's ownership. A supplier's or importer's invoice must name them; the dealership issues none for its margin.",
    "جهة إصدار الفاتورة المسجَّلة لا تناسب ملكية هذه السيارة. فاتورة المورّد أو المستورد يجب أن تسمّيه؛ والمعرض لا يصدر فاتورة عن هامشه.",
  ],
  ClosingReason_RECOGNITION_HANDOVER_PENDING: [
    "The sale is recognised on the vehicle handover date. Register the handover first.",
    "يُعترف بالبيع في تاريخ تسليم السيارة. سجّل التسليم أولًا.",
  ],
  ClosingReason_RECOGNITION_PERIOD_NOT_OPEN: [
    "The vehicle was handed over on a date that has no open accounting period. Open or reopen that period before closing.",
    "سُلّمت السيارة في تاريخ ليست له فترة محاسبية مفتوحة. افتح تلك الفترة أو أعد فتحها قبل الإغلاق.",
  ],
  ClosingReason_WITHHELD_RECOGNITION_PERIOD_OPEN: [
    "The accounting period for the handover date is not open.",
    "الفترة المحاسبية لتاريخ التسليم غير مفتوحة.",
  ],
  ClosingReason_CHECK_REFUSED: [
    "This condition could not be confirmed from the deal's records. Have the deal reviewed before closing.",
    "تعذّر تأكيد هذا الشرط من سجلات الصفقة. اطلب مراجعة الصفقة قبل الإغلاق.",
  ],
  ClosingReason_READINESS_CURRENCY_DRIFT: [
    "This deal's figures were recorded in {recordedCurrency}, but the organization's currency is now {orgCurrency}. Restore it to {recordedCurrency} before closing.",
    "سُجّلت أرقام هذه الصفقة بعملة {recordedCurrency}، لكن عملة المؤسسة أصبحت {orgCurrency}. أعِدها إلى {recordedCurrency} قبل الإغلاق.",
  ],
  ClosingReason_READINESS_INPUTS_UNAVAILABLE: [
    "This deal's closing inputs could not be established from its records, so readiness cannot be checked.",
    "تعذّر تحديد مدخلات إغلاق هذه الصفقة من سجلاتها، لذلك لا يمكن فحص الجاهزية.",
  ],
  ClosingReason_NOT_READY: ["This deal is not ready to be closed.", "هذه الصفقة غير جاهزة للإغلاق."],
  ClosingReason_DEAL_MODE_RETIRED: [
    "Lease and in-house instalment deals are no longer offered, so this deal cannot be finalized. Cancel it and start a cash or finance-company deal.",
    "لم تعد صفقات التأجير والتقسيط الداخلي متاحة، لذلك لا يمكن إنهاء هذه الصفقة. ألغِها وابدأ صفقة نقدية أو عبر شركة تمويل.",
  ],
  ClosingReason_WITHHELD_DEAL_MODE_RETIRED: [
    "This deal is in a mode that is no longer offered.",
    "هذه الصفقة بنمط لم يعد متاحًا.",
  ],
  ClosingReason_WITHHELD_REMITTANCE_KNOWN: [
    "What the finance company will remit is not established yet.",
    "لم يُحدَّد بعد المبلغ الذي ستحوّله شركة التمويل.",
  ],
  ClosingReason_WITHHELD_CONFIGURED_FEES_RECORDED: [
    "A fee the finance company configures has no actual recorded yet.",
    "يوجد رسم تضبطه شركة التمويل لم يُسجَّل مبلغه الفعلي بعد.",
  ],
  ClosingReason_WITHHELD_CUSTODY_ON_LEDGER: [
    "Employee custody on this deal is not fully on the books yet.",
    "عهدة الموظفين على هذه الصفقة لم تُرحَّل بالكامل إلى الدفاتر بعد.",
  ],
  ClosingReason_WITHHELD_CUSTODY_SETTLED: [
    "An employee custody record on this deal is not settled yet.",
    "يوجد سجل عهدة موظف على هذه الصفقة لم يُسوَّ بعد.",
  ],
  ClosingReason_WITHHELD_COSTS_CLOSABLE: [
    "The deal's costs are not all recorded and reconciled yet.",
    "لم تُسجَّل مصاريف الصفقة وتُسوَّ كلها بعد.",
  ],
  ClosingReason_WITHHELD_HANDOVER_COSTS_PAID: [
    "A handover cost on this deal has not been paid from a recorded source yet.",
    "يوجد مصروف تسليم على هذه الصفقة لم يُسجَّل له مصدر دفع بعد.",
  ],
  ClosingReason_WITHHELD_FIRST_PAYMENT_RECORDED: [
    "The customer's first payment is not recorded yet.",
    "لم تُسجَّل الدفعة الأولى للعميل بعد.",
  ],
  ClosingReason_WITHHELD_LEGAL_INVOICE_RECORDED: [
    "The legal invoice is missing, or the one recorded does not agree with this deal.",
    "الفاتورة القانونية غير مسجَّلة، أو أن المسجَّلة منها لا تتفق مع هذه الصفقة.",
  ],
  // SCRUM-420 — the financing figures are flagged for a reconciliation review.
  ClosingReason_FINANCING_RECONCILIATION_FLAGGED: [
    "This deal's financing figures are flagged for reconciliation review. Review them and record the review before closing.",
    "أرقام التمويل في هذه الصفقة موسومة لمراجعة التسوية. راجِعها وسجِّل ما راجعته قبل الإغلاق.",
  ],
  ClosingReason_WITHHELD_FINANCING_RECONCILED: [
    "The financing figures are still flagged for review.",
    "ما زالت أرقام التمويل موسومة لمراجعة التسوية.",
  ],
  // SCRUM-766 PR-B — the customer's agreed payment to the finance company needs a confirmed payment behind it.
  ClosingReason_CUSTOMER_FINANCE_COMPANY_PAYMENT_UNCONFIRMED: [
    "The customer agreed to pay part of the shortfall to the finance company, but that payment is not confirmed in full. Confirm the payment before closing, or settle the shortfall another way.",
    "اتفق العميل على دفع جزء من العجز لشركة التمويل، لكن هذه الدفعة غير مؤكَّدة بالكامل. أكِّد الدفعة قبل الإغلاق، أو سوِّ العجز بطريقة أخرى.",
  ],
  ClosingReason_CUSTOMER_FINANCE_COMPANY_PAYMENT_SUPERSEDED: [
    "A payment from the customer to the finance company was confirmed against an agreement that has since been withdrawn, so this deal's figures do not account for it. Take that confirmation back with a reason first; then, if the transfer still stands, record it again against the current agreement. Close the deal after that.",
    "أُكِّدت دفعة من العميل إلى شركة التمويل مقابل اتفاق سُحب لاحقًا، فلا تحتسبها أرقام هذه الصفقة. تراجَع أولًا عن ذلك التأكيد مع ذكر السبب؛ ثم، إن كان التحويل ما زال قائمًا، سجِّله من جديد مقابل الاتفاق الحالي. أغلق الصفقة بعد ذلك.",
  ],
  ClosingReason_WITHHELD_CUSTOMER_FINANCE_COMPANY_PAYMENT_CONFIRMED: [
    "A payment the customer made, or agreed to make, to the finance company is not settled in the deal's records yet.",
    "دفعة سدّدها العميل أو اتفق على سدادها لشركة التمويل لم تُسوَّ بعد في سجلات الصفقة.",
  ],
  ClosingReason_WITHHELD_UNAVAILABLE: [
    "This deal's closing readiness cannot be determined from its current records. Someone with finance access can see why.",
    "لا يمكن تحديد جاهزية إغلاق هذه الصفقة من سجلاتها الحالية. يمكن لمن لديه صلاحية الاطلاع على المالية معرفة السبب.",
  ],
});
