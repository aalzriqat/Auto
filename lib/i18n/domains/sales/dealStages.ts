import { defineBilingualMessages } from "../../defineBilingualMessages";

export const dealStageMessages = defineBilingualMessages({
  /**
   * Named for the money moving, not for a form being filled in. This is the
   * moment the dealer actually cares about, and it was invisible until it got
   * its own stage — folded into "financial settlement", which reads as
   * paperwork.
   *
   * "صرف" is what a finance company actually does with the money, and what a
   * dealer says on the phone. "دفعة" would have read as the customer's payment.
   */
  StageDisbursement: ["Confirm finance company payment", "تأكيد صرف شركة التمويل"],

  /**
   * TRANSITIONAL. It did its job in the previous release; it is kept here as
   * DEFERRED CLEANUP, not as a compatibility requirement.
   *
   * The previous release shipped the DISBURSEMENT stage from the backend while
   * the deployed cockpit was still the build before it, which resolved a stage
   * label as `t(STAGE_LABEL[key] ?? key)` — so without this entry the rail
   * rendered the bare string "DISBURSEMENT" for that window.
   *
   * Each Vercel deployment is an IMMUTABLE, SELF-CONTAINED bundle carrying its
   * own frozen copy of this dictionary, so no running frontend reads this
   * source entry and deleting it is safe. It stays only because retiring it
   * also means retiring `lib/i18n/deployedStageLabels.test.ts`, which is
   * cleanup for the Review-retirement slice. The cockpit in this build never
   * reads it; it uses `StageDisbursement` above.
   */
  DISBURSEMENT: ["Finance company payment", "صرف شركة التمويل"],

  /**
   * Whose move is it — the distinction the whole screen turns on. A stage that
   * belongs to the finance company must never read as something the dealership
   * has failed to do, and the badge is what stops an operator hunting for a
   * button that must not exist.
   */
  StageOwnerFinanceCompany: ["Finance company", "شركة التمويل"],
  StageOwnerDealership: ["Dealership", "المعرض"],

  /**
   * Says what AutoFlow's role is, in the one place an operator is looking at a
   * step they cannot take. AutoFlow never approves or evaluates a financing
   * request; it writes down what the finance company decided.
   */
  StageMirrorNote: [
    "This step is the finance company's. AutoFlow records what they decide — it does not approve financing.",
    "هذه الخطوة على شركة التمويل. يسجّل أوتوفلو ما تُقرّره، ولا يمنح موافقة على التمويل.",
  ],

  /** A DEALER stage that is genuinely ready — nothing outstanding, nothing awaited. */
  StageReadyToProceed: [
    "Nothing is outstanding on this step.",
    "لا يوجد ما ينتظر إكماله في هذه الخطوة.",
  ],

  /** Handover stage ready: all requirements met, prompt operator to register vehicle handover. */
  StageReadyForHandoverAction: [
    "All handover requirements are complete. When the vehicle is handed over to the customer, register handover here.",
    "جميع متطلبات التسليم مكتملة. عند تسليم المركبة للعميل، سجّل التسليم هنا.",
  ],

  /**
   * Waiting on THEM, and it says so. Deliberately not "payment is outstanding",
   * which reads like a dealership failure for a payment the dealership cannot
   * make happen.
   */
  BlockerAwaitingDisbursement: [
    "Waiting on the finance company to pay",
    "بانتظار صرف شركة التمويل",
  ],

  /**
   * SCRUM-435. The finance company sends the FULL approved amount; before that
   * transfer is confirmed the dealership pays it the customer's deposit and its
   * own contribution. These name the dealership as the one to act.
   */
  BlockerAwaitingForwardToFinanceCompany: [
    "The deposit and the dealership's contribution are paid to the finance company first",
    "يُدفع العربون ومساهمة المعرض لشركة التمويل أولاً",
  ],
  BlockerForwardNotSettled: [
    "The payment to the finance company is not settled on the books yet",
    "الدفعة المسدَّدة لشركة التمويل لم تُسوَّ في الدفاتر بعد",
  ],
  RecordForwardToFinanceCompany: [
    "Record payment to the finance company",
    "سجّل الدفع لشركة التمويل",
  ],
  ForwardNeedsPermission: [
    "A manager or accountant records the payment to the finance company.",
    "يسجّل المدير أو المحاسب الدفع لشركة التمويل.",
  ],
  ForwardNotSettledReason: [
    "An accountant resolves the payment to the finance company before the transfer can be confirmed.",
    "يعالج المحاسب الدفع لشركة التمويل قبل أن يمكن تأكيد التحويل.",
  ],
  /**
   * SCRUM-411 P2-01. The deposit and the contribution are paid to the finance
   * company BEFORE the deal is closed; the close waits for the payment to be on
   * the books for the figures the close would freeze. Each names who acts next.
   */
  FinalizeNeedsForwardPayment: [
    "The customer's deposit and the dealership's contribution are paid to the finance company before the deal is closed. Record that payment, then close the deal.",
    "يُدفع عربون العميل ومساهمة المعرض لشركة التمويل قبل إغلاق الصفقة. سجّل هذا الدفع ثم أغلق الصفقة.",
  ],
  FinalizeForwardPaymentStale: [
    "The payment to the finance company was recorded against different figures than this deal has now. A manager or accountant voids it (Void the payment, above) and records it again before the deal is closed.",
    "سُجّل الدفع لشركة التمويل على أرقام تختلف عمّا في الصفقة الآن. يلغي المدير أو المحاسب هذا الدفع (إلغاء الدفع، في الأعلى) ويسجّله من جديد قبل إغلاق الصفقة.",
  ],
  FinalizeForwardPaymentPosting: [
    "The payment to the finance company is recorded but not yet posted to the books. An accountant posts it before the deal is closed.",
    "الدفع لشركة التمويل مسجَّل لكنه لم يُرحَّل إلى الدفاتر بعد. يرحّله المحاسب قبل إغلاق الصفقة.",
  ],
  FinalizeForwardPaymentPostingFailed: [
    "The payment to the finance company failed to post to the books. An accountant resolves it before the deal is closed.",
    "تعذّر ترحيل الدفع لشركة التمويل إلى الدفاتر. يعالجه المحاسب قبل إغلاق الصفقة.",
  ],
  FinalizeForwardPaymentReversing: [
    "The payment to the finance company is being reversed and the reversal is not yet posted. An accountant posts it before the deal is closed.",
    "يجري عكس الدفع لشركة التمويل ولم يُرحَّل العكس بعد. يرحّله المحاسب قبل إغلاق الصفقة.",
  ],
  FinalizeForwardPaymentNeedsReview: [
    "The record of the payment to the finance company does not match the books. An accountant reviews it before the deal is closed.",
    "سجل الدفع لشركة التمويل لا يطابق الدفاتر. يراجعه المحاسب قبل إغلاق الصفقة.",
  ],
  FinalizeFirstPaymentUnfunded: [
    "The customer's first payment was agreed on the strength of a reservation deposit that has since been refunded or forfeited, so nothing funds it. A manager reopens the approval and amends the first payment before the deal is closed.",
    "اتُّفق على الدفعة الأولى للعميل اعتمادًا على عربون حجز جرى استرداده أو مصادرته لاحقًا، فلا يوجد ما يموّلها. يعيد المدير فتح الموافقة ويعدّل الدفعة الأولى قبل إغلاق الصفقة.",
  ],
  ForwardReturnedNotSettledReason: [
    "The finance company returned the payment. An accountant resolves its reversal before the replacement payment can be recorded.",
    "أعادت شركة التمويل الدفعة. يعالج المحاسب عكسها قبل أن يمكن تسجيل الدفعة البديلة.",
  ],
  ManagerCancelsFinalizedDeal: [
    "A manager cancels a finalized deal.",
    "يلغي المدير الصفقة المُنهاة.",
  ],
  CancelWaitsForForward: [
    "This deal can be cancelled once the payment to the finance company is resolved.",
    "يمكن إلغاء هذه الصفقة بعد معالجة الدفع لشركة التمويل.",
  ],
  RecordForwardTitle: [
    "Record payment to the finance company",
    "تسجيل الدفع لشركة التمويل",
  ],
  RecordForwardDesc: [
    "The finance company sends the full approved amount. Record here what the dealership pays it back: the customer's deposit and the dealership's own contribution. Nothing is deducted.",
    "ترسل شركة التمويل المبلغ المعتمد كاملاً. سجّل هنا ما يدفعه المعرض لها: عربون العميل ومساهمة المعرض. لا يُخصم شيء.",
  ],
  RecordForwardAmount: ["Amount to pay", "المبلغ المستحق الدفع"],
  RecordForwardDeposit: ["Deposit forwarded", "العربون المحوَّل لشركة التمويل"],
  RecordForwardExcess: ["Kept as dealer income (excess)", "يحتفظ به المعرض كإيراد (الفائض)"],
  RecordForwardContribution: ["Dealership contribution", "مساهمة المعرض"],
  RecordForwardConfirm: ["Record payment", "تسجيل الدفع"],
  ForwardRecordedSuccess: [
    "Payment to the finance company recorded",
    "تم تسجيل الدفع لشركة التمويل",
  ],
  ForwardVoidAction: ["Void the payment", "إلغاء الدفع"],
  ForwardReturnedAction: ["Report returned by the company", "الإبلاغ عن إرجاع الشركة للمبلغ"],
  ForwardVoidTitle: ["Void the payment to the finance company", "إلغاء الدفع لشركة التمويل"],
  ForwardVoidDesc: [
    "Use this when the payment was recorded by mistake and the finance company has not sent the transfer yet. The payment is reversed on the books and becomes due again.",
    "استخدمه إذا سُجّل الدفع بالخطأ ولم ترسل شركة التمويل التحويل بعد. يُعكس الدفع في الدفاتر ويصبح مستحقاً من جديد.",
  ],
  ForwardReturnedTitle: ["Report the payment returned", "الإبلاغ عن إرجاع الدفع"],
  ForwardReturnedDesc: [
    "Use this when the finance company sent the payment back. It is reversed on the books and becomes due again, so the deal can be cancelled or the payment recorded once more.",
    "استخدمه إذا أعادت شركة التمويل الدفع. يُعكس في الدفاتر ويصبح مستحقاً من جديد، فيمكن إلغاء الصفقة أو تسجيل الدفع مرة أخرى.",
  ],
  ForwardReasonLabel: ["Reason", "السبب"],
  ForwardReasonRequired: ["A reason is required.", "السبب مطلوب."],
  ForwardCorrectionSuccess: ["Payment to the finance company corrected", "تم تصحيح الدفع لشركة التمويل"],
  // SCRUM-239: the bank returned the finance company's cheque after it cleared.
  ChequeReturnedByBankAction: ["Cheque returned by bank", "شيك مرتجع من البنك"],
  ChequeReturnedByBankTitle: ["Cheque returned by bank", "شيك مرتجع من البنك"],
  ChequeReturnedByBankDesc: [
    "Use this when the bank returned the finance company's cheque after it was cleared. The finance company's receipt comes off the books, the finance company's receivable reopens, and the deal goes back to waiting for a new cheque and a new disbursement.",
    "استخدمه إذا أرجع البنك شيك شركة التمويل بعد صرفه. يُلغى قيد استلام مبلغ شركة التمويل من الدفاتر، وتعود ذمة شركة التمويل مفتوحة، وتعود الصفقة بانتظار شيك جديد وصرف التمويل من جديد.",
  ],
  ChequeReturnedByBankReasonLabel: ["Return reason", "سبب الإرجاع"],
  ChequeReturnedByBankConfirm: ["Record the return", "تسجيل الإرجاع"],
  ChequeReturnedByBankSuccess: [
    "Cheque return recorded. The deal is waiting for a new cheque.",
    "تم تسجيل الشيك المرتجع. الصفقة بانتظار شيك جديد.",
  ],
  // SCRUM-239 round 4: the deal's disbursement moved while the confirm dialog was open.
  DisbursementChangedWhileConfirming: [
    "This deal's disbursement changed while the confirmation was open (a cheque was returned). Nothing was confirmed. Reopen and review before confirming.",
    "تغيّر صرف هذه الصفقة أثناء فتح نافذة التأكيد (تم إرجاع شيك). لم يتم تأكيد أي شيء. أعد فتح النافذة وراجع قبل التأكيد.",
  ],
  // SCRUM-239 round 5: same, but a confirmation had been SENT and its answer never arrived here.
  DisbursementChangedOutcomeUnknown: [
    "This deal's disbursement changed (a cheque was returned) after a confirmation was sent, and that confirmation's result is not known on this screen. Review the deal's receipts and cheque history before confirming again.",
    "تغيّر صرف هذه الصفقة (تم إرجاع شيك) بعد إرسال تأكيد، ونتيجة ذلك التأكيد غير معروفة على هذه الشاشة. راجع مقبوضات الصفقة وسجل الشيكات قبل التأكيد مرة أخرى.",
  ],
  ForwardVoidAfterTransfer: [
    "The finance company's transfer is now confirmed, so this payment can no longer be voided. If the company sent it back, report it as returned.",
    "تم تأكيد تحويل شركة التمويل، لذا لم يعد بالإمكان إلغاء هذا الدفع. إذا أعادته الشركة، أبلغ عن إرجاعه.",
  ],
  /** Settlement node while the payment step is live: it closes only once the money arrives. */
  BlockerSettlementAfterFinancePayment: [
    "Completes after the finance company pays",
    "تكتمل بعد صرف شركة التمويل",
  ],

  /**
   * Disbursement stage in rail ahead of handover: clarifies that disbursement
   * confirmation occurs after handover and finalization.
   */
  BlockerDisbursementAfterHandover: [
    "Recorded after vehicle handover and finalization",
    "يُسجَّل بعد تسليم المركبة وإتمام الصفقة",
  ],

  /** Handover loss confirmation warning: when estimated management profit is negative. */
  HandoverLossWarning: [
    "Warning: this deal is currently forecasting an estimated loss.",
    "تحذير: هذه الصفقة تُسجِّل خسارة تقديرية.",
  ],
  HandoverLossWarningDesc: [
    "Verify the deal figures and terms before confirming vehicle handover.",
    "تحقّق من أرقام وتفاصيل الصفقة قبل تأكيد تسليم المركبة.",
  ],
  HandoverActualLossWarning: [
    "Warning: this deal has an actual loss in its settled management economics.",
    "تحذير: هذه الصفقة تسجّل خسارة فعلية في أرقام الإدارة بعد التسوية.",
  ],
  HandoverActualLossWarningDesc: [
    "Verify the settled deal figures before confirming vehicle handover. This management result is actual but is not posted to the books.",
    "تحقّق من أرقام الصفقة بعد التسوية قبل تأكيد تسليم المركبة. هذه نتيجة إدارية فعلية لكنها غير مُرحّلة إلى الدفاتر.",
  ],

  /**
   * The appraisal stage when the appraiser is NOT on record.
   *
   * Deliberately not "the finance company". `APPRAISAL` is a MIRROR stage, so
   * the rail would otherwise name them by default — but the vehicle may be
   * valued by an independent appraiser instead, and a deal with no active
   * appraisal at all has no appraiser to name. Also covers a DEALER_ESTIMATE,
   * which is neither party the badge can name.
   */
  StageOwnerAppraiserNotRecorded: ["Appraiser not recorded", "جهة التخمين غير مسجّلة"],

  /**
   * A rejected or cancelled deal that is still holding the customer's deposit.
   *
   * The wording avoids naming a resolution: refunding and forfeiting are
   * different decisions with different accounting. It says money is being held
   * and that somebody must decide — which is what the applications list has
   * always said, and what this screen used to omit entirely.
   */
  DepositAwaitingResolutionTitle: [
    "A customer deposit is still being held",
    // `عربون` is MASCULINE, so `ما زال … محتجزاً`, not the feminine agreement.
    "ما زال عربون العميل محتجزاً",
  ],
  DepositAwaitingResolutionBody: [
    "This deal is closed, but the deposit has not been refunded or forfeited. Until it is, the money sits against the customer with no outcome recorded.",
    "أُغلقت هذه الصفقة دون ردّ العربون أو مصادرته. وحتى يتم ذلك، يبقى المبلغ مقيّداً على العميل دون نتيجة مسجّلة.",
  ],

  /**
   * The finance company's credit decision, RECORDED on the deal.
   *
   * AutoFlow never approves financing. Every string here says the company
   * decided and the dealership wrote it down; the two outcomes are offered as
   * equals, not as a green "approve" and a red "reject".
   */
  RecordCreditDecisionAction: ["Record the finance company's decision", "تسجيل قرار شركة التمويل"],
  RecordCreditDecisionTitle: ["The finance company's decision", "قرار شركة التمويل"],
  RecordCreditDecisionDesc: [
    "Record what the finance company decided about this application. AutoFlow writes the decision down; it does not make one.",
    "سجِّل ما قرّرته شركة التمويل بشأن هذا الطلب. يدوّن أوتوفلو القرار ولا يتّخذه.",
  ],
  CreditDecisionApproved: ["They approved the financing", "وافقت على التمويل"],
  CreditDecisionApprovedHint: [
    "The application moves on to the appraisal and the approved purchase amount.",
    "ينتقل الطلب إلى التخمين والمبلغ المعتمد للشراء.",
  ],
  CreditDecisionRejected: ["They declined the financing", "رفضت التمويل"],
  CreditDecisionRejectedHint: [
    "The deal stops here. Any held deposit will need to be refunded or forfeited.",
    "تتوقّف الصفقة هنا. وأي عربون محتجز سيلزم ردّه أو مصادرته.",
  ],
  RecordCreditDecisionConfirm: ["Record decision", "تسجيل القرار"],
  CreditDecisionApproveNeedsPermission: [
    "A Manager records the finance company's approval.",
    "يسجّل المدير موافقة شركة التمويل.",
  ],
  CreditDecisionRejectNeedsPermission: [
    "A Manager records the finance company's rejection.",
    "يسجّل المدير رفض شركة التمويل.",
  ],
  CreditDecisionOwnDeal: [
    "You submitted this application, so another Manager records its approval.",
    "أنت من قدّم هذا الطلب، لذا يسجّل الموافقة مدير آخر.",
  ],
  CreditDecisionNeedsPermission: [
    "A Manager records the finance company's decision.",
    "يسجّل المدير قرار شركة التمويل.",
  ],

  /**
   * Why the DISBURSEMENT step offers no button to this caller. The
   * permission case and the not-yet case are different sentences: one names
   * a person, the other names a fact about the deal.
   */
  DisbursementNeedsPermission: [
    "A Manager or Accountant confirms the finance company's payment.",
    "يؤكد المدير أو المحاسب صرف شركة التمويل.",
  ],
  DisbursementUnavailable: [
    "Nothing is expected from the finance company on this deal, or the receipt is already on record.",
    "لا يوجد مبلغ متوقّع من شركة التمويل على هذه الصفقة، أو أن الاستلام مسجّل بالفعل.",
  ],
  SupplierDisbursementUnavailable: [
    "The supplier's payment cannot be recorded on this deal: the direct route is not available, or the advice is already on record.",
    "لا يمكن تسجيل دفعة المورّد على هذه الصفقة: المسار المباشر غير متاح، أو أن الإشعار مسجّل بالفعل.",
  ],

  /**
   * TEMPORARY CONTAINMENT (SCRUM-215 SN3-1 → SCRUM-241). The deal's settlement
   * is recorded in a currency other than the organisation's current one, and
   * confirming the receipt is certain to be refused by the ledger — so the
   * action is withheld and the reason said. No conversion is offered, no
   * repair is suggested, and nothing has been posted.
   */
  DisbursementCurrencyUnsupported: [
    "This deal's settlement is recorded in a currency AutoFlow does not recognise. The receipt cannot be confirmed until the recorded currency is corrected; nothing has been posted.",
    "تسوية هذه الصفقة مسجّلة بعملة لا يتعرّف عليها AutoFlow. لا يمكن تأكيد الاستلام حتى تُصحَّح العملة المسجّلة؛ لم يُرحَّل أي قيد.",
  ],
  FinalizeCurrencyMismatch: [
    "This deal's figures were recorded in a currency that differs from the organisation's current currency. A deal is closed in the currency its figures were recorded in, so the close is withheld until the organisation's currency is restored to the recorded one; nothing has been posted.",
    "أرقام هذه الصفقة مسجّلة بعملة تختلف عن العملة الحالية للمؤسسة. تُغلق الصفقة بالعملة التي سُجِّلت بها أرقامها، لذا يُحجب الإغلاق حتى تُعاد عملة المؤسسة إلى العملة المسجّلة؛ لم يُرحَّل أي قيد.",
  ],
  FinalizeCurrencyUnsupported: [
    "This deal's economics are recorded in a currency AutoFlow does not recognise. The close is withheld until the recorded currency is corrected.",
    "اقتصاديات هذه الصفقة مسجّلة بعملة لا يتعرّف عليها AutoFlow. يُحجب الإغلاق حتى تُصحَّح العملة المسجّلة.",
  ],
  /** Prefix for the withheld figure, spelled in the currency it is recorded in. */
  RecordedSettlementAmount: ["Recorded settlement", "التسوية المسجّلة"],
  /** Prefix for the currency a deal's figures were pinned in. */
  RecordedEconomicsCurrency: ["Recorded currency", "العملة المسجّلة"],

  /**
   * The customer's financing plan on the Deal — read-only, what the customer
   * agreed to pay; explicitly not the dealer's remittance or profit.
   */
  FinancingPlanHeading: ["Original quotation financing plan", "خطة التمويل في عرض السعر الأصلي"],
  FinancingPlanNote: [
    "Original quotation terms — may differ from currently approved deal terms.",
    "شروط التمويل في عرض السعر الأصلي — قد تختلف عن شروط الصفقة المعتمدة الحالية.",
  ],
  FinancingProvider: ["Financier", "جهة التمويل"],
  CustomerPrice: ["Vehicle price", "سعر السيارة"],
  DownPaymentLabel: ["Down payment", "الدفعة الأولى"],
  FinancedAmountLabel: ["Financed amount", "المبلغ المموَّل"],
  TermLabel: ["Term", "المدة"],
  MonthsUnit: ["months", "شهرًا"],
  InstallmentLabel: ["Monthly instalment", "القسط الشهري"],
  NationalIdLabel: ["National ID", "الرقم الوطني"],
  ShowNationalId: ["Show national ID", "إظهار الرقم الوطني"],
  HideNationalId: ["Hide national ID", "إخفاء الرقم الوطني"],
  /** A fact the record does not carry; never rendered as a zero. */
  FactUnavailable: ["Not recorded", "غير مسجّل"],

  /**
   * The Deal's identity strip and vehicle card (SCRUM-372). The reference is
   * the record's own opaque id, labelled for the record it is. The deal number
   * beside it is the one the server issues per organization (SCRUM-808,
   * `formatDealNumber`), never one formatted on the screen from the id.
   */
  DealTypeLabel: ["Deal type", "نوع الصفقة"],
  DealNumberLabel: ["Deal number", "رقم الصفقة"],
  DealNumberSearchResult: ["Deal", "صفقة"],
  DealReferenceApplication: ["Application ID", "مرجع الطلب"],
  DealReferenceSale: ["Sale ID", "مرجع البيع"],
  CopyDealReference: ["Copy reference", "نسخ المرجع"],
  DealReferenceCopied: ["Reference copied", "تم نسخ المرجع"],
  DealVehicleCardHeading: ["Vehicle details", "معلومات المركبة"],
  DealVehicleNoPhoto: ["No vehicle photo", "لا توجد صورة للمركبة"],
  DealVehicleColor: ["Colour", "اللون"],
  DealVehicleMileage: ["Mileage", "العداد"],
  DealVehicleMileageUnit: ["km", "كم"],
  DealVehicleOwnership: ["Ownership", "الملكية"],
});

export const dealDepositMessages = defineBilingualMessages({
  /** A document rule the finance company waived for this deal. */
  DocWaived: ["Waived", "مُعفى"],

  /**
   * Why a held deposit is listed here but not resolved here: part of it is
   * applied, assigned to a car, awaiting its own decision, or already paid
   * out, so its face value is not what a release would move. Deliberately
   * makes NO claim about what another screen displays — the vehicle's deposit
   * manager is the established path, and the server releases only the free
   * remainder there too.
   */
  DepositResolveElsewhere: [
    "Part of this deposit is applied, assigned to a vehicle, or already paid out, so its face value is not what a release would move. It is not resolved from here; use the vehicle's deposit manager, where only the free remainder is released.",
    "جزء من هذا العربون مطبَّق أو مخصَّص لمركبة أو مدفوع مسبقاً، لذا فإن قيمته الاسمية ليست ما سيُصرف عند التحرير. لا تتم معالجته من هنا؛ استخدم إدارة العربون في صفحة المركبة، حيث لا يُصرف إلا المتبقي الحر.",
  ],
});
