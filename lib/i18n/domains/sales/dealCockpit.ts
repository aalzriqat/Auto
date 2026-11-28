import { defineBilingualMessages } from "../../defineBilingualMessages";
import { customerReceiptMessages } from "./customerReceipts";

// SCRUM-969: cancelling a CASH deal from its own screen. Worded for a sale, never for an
// application; the warnings state only what the server's cancel path does for each status.
const cashDealCancelMessages = defineBilingualMessages({
  CancelDealAction: ["Cancel deal", "إلغاء الصفقة"],
  CancelDealTitle: ["Cancel this deal?", "هل تريد إلغاء هذه الصفقة؟"],
  CancelDealDraftWarning: [
    "This cancels the draft sale only. It posts nothing, and any deposit already received and the vehicle's hold are left as they are. A cancelled deal cannot be reopened; record a new sale to redo it.",
    "سيؤدي هذا إلى إلغاء مسودة البيع فقط. لا يُرحَّل أي قيد محاسبي، ويبقى أي عربون مستلم وحجز المركبة كما هما. لا يمكن إعادة فتح الصفقة الملغاة؛ سجّل عملية بيع جديدة لإعادتها.",
  ],
  CancelDealCompletedWarning: [
    "This deal is completed. Cancelling reverses what the sale posted, including its commission, releases the vehicle from the sale and reverses any deposit applied to it; that money is held until someone decides what happens to it, and is not returned to the customer automatically. If the sale credited a trade-in value, that trade-in vehicle has its purchase cost cleared and, if it was available for sale, moves to inspection. Supplier payables on the sale, any claim on the supplier for a consigned car settled direct to the supplier, and any warranty or GAP deferrals are cancelled. A cancelled deal cannot be reopened. The system refuses and explains if it cannot, for example when the commission was already paid, a supplier payment was already made or received, the trade-in vehicle was already resold or the customer holds invoice credit on this sale.",
    "هذه الصفقة مكتملة. سيؤدي الإلغاء إلى عكس ما رحّله البيع من قيود، ومنها العمولة، وفكّ ارتباط المركبة بالبيع، وعكس أي عربون طُبّق عليه؛ ويبقى هذا المبلغ معلّقًا بانتظار قرار بشأنه، ولا يُعاد إلى العميل تلقائيًا. وإذا احتُسبت قيمة استبدال في البيع، تُمسح تكلفة شراء مركبة الاستبدال، وإن كانت متاحة للبيع فإنها تنتقل إلى الفحص. وتُلغى مستحقات المورد على الصفقة، وأي مطالبة للمعرض على المورد عن مركبة برسم البيع تُسوّى مباشرة مع المورد، وأي تأجيلات خاصة بالضمان أو GAP. لا يمكن إعادة فتح الصفقة الملغاة. يرفض النظام الإلغاء ويوضّح السبب إن تعذّر، مثلاً إذا كانت العمولة قد دُفعت أو سُدِّدت دفعة للمورد أو سُجّل استلام مقابل المطالبة على المورد أو أُعيد بيع مركبة الاستبدال أو كان للعميل رصيد فاتورة على هذه الصفقة.",
  ],
  CancelDealKeep: ["Keep deal", "الإبقاء على الصفقة"],
  CancelDealSuccess: ["Deal cancelled.", "تم إلغاء الصفقة."],
  CancelDealChanged: [
    "The deal's status changed while this window was open, so the confirmation was closed. Open Cancel deal again to read the warning that now applies.",
    "تغيّرت حالة الصفقة أثناء فتح نافذة التأكيد، فأُغلقت النافذة. افتح «إلغاء الصفقة» من جديد لقراءة التحذير الحالي.",
  ],
  CancelDealRefusedLead: ["Could not cancel the deal:", "تعذّر إلغاء الصفقة:"],
});
const dealCockpitStages = defineBilingualMessages({
  // --- Financed-deal cockpit -------------------------------------------
  // --- شاشة صفقة التمويل -------------------------------------------------
  DealCockpitTitle: ["Finance application", "طلب تمويل"],
  DealOwner: ["Owner", "المسؤول"],
  LastUpdated: ["Last updated", "آخر تحديث"],
  StagesCompleted: ["stages complete", "مراحل مكتملة"],
  StageCompletedOne: ["stage complete", "مرحلة مكتملة"],
  StageApplication: ["Application", "تقديم الطلب"],
  StageCreditDecision: ["Credit decision", "القرار الائتماني"],
  StageAppraisal: ["Appraisal", "التخمين"],
  StageGapResolution: ["Shortfall", "العجز"],
  StageApprovedPurchase: ["Approved purchase amount", "قيمة الشراء المعتمدة"],
  StageDeliveryActions: ["Delivery actions", "إجراءات التسليم"],
  StageHandover: ["Vehicle handover", "تسليم المركبة"],
  StageSettlement: ["Financial settlement", "التسوية المالية"],
  BlockerAwaitingCreditDecision: ["Waiting on the finance company's decision", "بانتظار قرار شركة التمويل"],
  BlockerAwaitingAppraisal: ["Waiting on the appraisal", "بانتظار التخمين"],
  BlockerGapUnresolved: ["The shortfall is not resolved", "العجز غير مُعالَج"],
  BlockerGapNegotiationFailed: ["Shortfall negotiation failed", "تعذّر الاتفاق على العجز"],
  BlockerNoApprovedPurchaseAmount: [
    "The approved purchase amount is not recorded",
    "قيمة الشراء المعتمدة غير مُسجَّلة",
  ],
  BlockerDocumentsIncomplete: ["Required documents are outstanding", "مستندات مطلوبة لم تُستكمل"],
  BlockerHandoverBlocked: ["The vehicle cannot be handed over yet", "لا يمكن تسليم المركبة بعد"],
  BlockerAwaitingSettlement: ["Waiting on settlement", "بانتظار التسوية"],
  NextStepHeading: ["Next step", "الخطوة التالية"],
  DealStopped: ["This deal is closed and will not continue.", "هذه الصفقة منتهية ولن تستكمل."],
  OwnershipWithSupplier: ["Ownership: with the supplier", "الملكية: لدى المورد"],
  OwnershipWithDealership: ["Ownership: dealership stock", "الملكية: لدى المعرض"],
  NetDealershipProfit: ["Net dealership profit", "صافي ربح المعرض"],
  ProfitEstimatedAwaitingSettlement: ["Estimated — awaiting settlement", "تقديري — بانتظار التسوية"],
  ProfitActualUnpostable: ["Actual — not posted to the books", "فعلي — غير مُرحَّل للقيود"],
  ProfitNotCalculable: ["Cannot be calculated yet", "لا يمكن احتسابه بعد"],
  ProfitOverviewWithheld: [
    "The deal overview did not serve a figure for this caller, so no profit is shown.",
    "لم يقدّم ملخص الصفقة رقمًا لهذا المستخدم، فلا يُعرض ربح.",
  ],
  ProfitNeedsApprovedPurchase: [
    "The finance company's approved purchase amount is not recorded.",
    "قيمة الشراء المعتمدة من شركة التمويل غير مُسجَّلة.",
  ],
  ProfitNeedsSupplierSettlement: ["What the supplier settles at is not recorded.", "قيمة تسوية المورد غير مُسجَّلة."],
  ProfitNeedsDealerContribution: [
    "The dealership's own contribution to the purchase is not recorded.",
    "مساهمة المعرض في قيمة الشراء غير مُسجَّلة.",
  ],
  ProfitNeedsVehicleCost: [
    "The vehicle's cost is not recorded, so there is nothing to measure the deal against.",
    "تكلفة المركبة غير مُسجَّلة، فلا يوجد ما تُقاس الصفقة عليه.",
  ],
  ProfitPreparationUnreadable: [
    "The showroom's expenses on the car cannot be read completely, so net profit is unavailable.",
    "تعذّرت قراءة جميع مصاريف المعرض على السيارة، فصافي الربح غير متاح.",
  ],
});

const dealProfitAccess = defineBilingualMessages({
  ProfitCommissionAccessRequired: [
    "Viewing net profit requires permission to view commissions.",
    "عرض صافي الربح يتطلب صلاحية عرض العمولات.",
  ],
  ProfitCostAccessRequired: [
    "Viewing net profit requires permission to view vehicle cost.",
    "عرض صافي الربح يتطلب صلاحية عرض تكلفة السيارة.",
  ],
  ProfitCommissionsPending: [
    "The commission has not been decided yet, so net profit is unavailable.",
    "لم تُحدّد العمولة بعد، لذلك لا يتوفر صافي الربح.",
  ],
  LineAccountingMargin: ["Accounting margin", "الهامش المحاسبي"],
});

const dealProfitExpenses = defineBilingualMessages({
  ProfitExpensesMixedDenomination: [
    "A cost the dealership bore is recorded in another currency, so the figure is withheld rather than computed over a partial total.",
    "أحد المصاريف التي تحمّلها المعرض مسجَّل بعملة أخرى، فحُجب الرقم بدل احتسابه على مجموع ناقص.",
  ],
  ProfitExpensesUnreadable: [
    "A recorded cost amount on this deal could not be read, so the figure is withheld rather than computed over a corrupt total.",
    "تعذّرت قراءة أحد مبالغ المصاريف المسجَّلة على هذه الصفقة، فحُجب الرقم بدل احتسابه على مجموع تالف.",
  ],
  ProfitExecutionFeeUnclassified: [
    "It is not clear which recorded cost is the finance company's execution fee, or the deal's frozen fee total disagrees with it, so the estimate is withheld until an accountant reconciles the deal's costs.",
    "لا يتضح أيّ المصاريف المسجَّلة هو رسوم تنفيذ شركة التمويل، أو أن مجموع الرسوم المجمَّد للصفقة يخالفها، فحُجب التقدير إلى أن يطابق المحاسب مصاريف الصفقة.",
  ],
  LinePreparationExpenses: ["Showroom expenses on the car", "مصاريف المعرض على السيارة"],
});

const dealCockpitMoney = defineBilingualMessages({
  ProfitInputCorrupt: [
    "One of the recorded amounts is not valid, so the figure cannot be trusted.",
    "أحد المبالغ المُسجَّلة غير صالح، لذا لا يمكن الاعتماد على الرقم.",
  ],
  ProfitDealCancelled: [
    "This deal was cancelled, so it has no profit to report.",
    "أُلغيت هذه الصفقة، فلا يوجد ربح لعرضه.",
  ],
  ManagementFigureNote: [
    "A management figure. It has no journal behind it and is never posted to the books.",
    "رقم إداري لا يقابله قيد محاسبي، ولا يُرحَّل إلى الدفاتر.",
  ],
  LineApprovedPurchase: ["Approved purchase amount (finance company)", "قيمة الشراء المعتمدة من شركة التمويل"],
  LineCustomerPlannedToDealer: [
    "Customer's planned shortfall contribution to the dealership (allocated, not yet received)",
    "مساهمة العميل المخطَّطة للمعرض من العجز (مخصَّصة، لم تُقبض بعد)",
  ],
  LineApprovalExcess: [
    "Excess: approved financing plus customer payment above the approved purchase amount",
    "الفائض: مبلغ التمويل المعتمد مع دفعة العميل فوق قيمة الشراء المعتمدة",
  ],
  LineSupplierSettlement: ["Supplier settlement", "تسوية المورد"],
  LineDealerContribution: ["Dealership contribution to financing", "مساهمة المعرض في التمويل"],
  LineActualExpenses: ["Actual expenses", "مصاريف فعلية"],
  LineForecastExpenses: ["Forecast expenses", "مصاريف متوقعة"],
  // --- Cash deal: the same screen, a different KIND of money ------------
  // The cash headline is an ordinary accounting result and reconciles to the
  // books, so it carries no "estimated / never posted" qualifier at all.
  // --- صفقة نقدية: نفس الشاشة، ونوع مختلف من الأرقام ---------------------
  DealCockpitTitleCash: ["Sale", "صفقة بيع"],
  StageSaleAgreed: ["Sale agreed", "اتفاق البيع"],
  // Named for the STATUS enum they render. `SaleCompleted` already exists as the
  // completion toast ("Sale Completed ✓"), and reusing it would have put a
  // celebratory tick inside a status timeline.
  SaleStatusPending: ["Pending", "قيد الإنجاز"],
  SaleStatusCompleted: ["Completed", "مكتملة"],
  LineSalePrice: ["Sale price", "سعر البيع"],
  LineVehicleCost: ["Vehicle cost", "تكلفة المركبة"],
  LineSupplierEntitlement: ["Supplier's entitlement", "مستحق المورد"],
  ProfitUnknownMargin: [
    "What this deal earned is not recorded, so it cannot be shown. It is not zero.",
    "ربح هذه الصفقة غير مُسجَّل، لذا لا يمكن عرضه. وهو ليس صفراً.",
  ],
  ProfitSaleNotCompleted: [
    "This sale has not been completed, so nothing has been posted to the books yet.",
    "لم تكتمل عملية البيع بعد، فلا توجد قيود مُرحَّلة إلى الدفاتر.",
  ],
  ProfitFinancedDirectUnverified: [
    "This deal was financed and settled directly with the supplier, and what the finance company approved is not recorded — so what the dealership earned cannot be shown.",
    "صفقة مموَّلة وتمت تسويتها مباشرة مع المورد، وقيمة الشراء المعتمدة من شركة التمويل غير مُسجَّلة، لذا لا يمكن عرض ربح المعرض.",
  ],
  ActualExpensesHeading: ["Actual expenses", "المصاريف الفعلية"],
  ExpensesAwaitingActuals: ["still without a recorded actual", "بلا مبلغ فعلي مُسجَّل"],
  NoExpensesRecorded: ["No expenses recorded yet.", "لا توجد مصاريف مُسجَّلة بعد."],
  DealPartiesHeading: ["Deal parties — who holds the money now", "أطراف الصفقة — من يحمل المال الآن"],
  PartyCustomer: ["Customer", "العميل"],
  PartySupplier: ["Supplier", "المورد"],
  PartyFinancier: ["Finance company", "شركة التمويل"],
  PositionDealershipHolds: ["Deposit held by the dealership", "عربون محجوز لدى المعرض"],
  PositionDealershipOwes: ["Due — not yet paid", "مستحقة — لم تُدفع"],
  PositionOwedToDealership: ["Still to collect", "متبقٍ تحصيله"],
  PositionSettled: ["Settled", "مسوَّاة"],
  PositionNotInvolved: ["Nothing outstanding", "لا يوجد"],
  PositionUnknown: ["Cannot be determined", "غير محدَّد"],
});

const dealSettlementMessages = defineBilingualMessages({
  AppraisalGapLabel: ["Shortfall", "العجز"],
  NoAppraisalGap: ["None", "لا يوجد"],
  AppraisalGapUnavailable: ["Cannot be worked out yet", "لا يمكن احتسابه بعد"],
  RouteUnknownWarning: [
    "The sale behind this deal could not be loaded, so which way it settles cannot be established. The figures that depend on it are withheld.",
    "تعذّر تحميل عملية البيع المرتبطة بهذه الصفقة، فلا يمكن تحديد طريقة التسوية. الأرقام المعتمدة عليها محجوبة.",
  ],
  // The settlement advice contradicts the approved purchase amount.
  SettlementAdviceDiscrepancyTitle: [
    "The settlement advice does not match what was approved",
    "إشعار التسوية لا يطابق المبلغ المعتمد",
  ],
  SettlementAdviceDiscrepancyBody: [
    "The finance company was approved to pay the supplier one amount and its advice records another. The supplier's debt is still measured against the approved amount and has not been changed. Check the advice against the document, and correct it here if it was entered wrongly.",
    "المبلغ الذي اعتُمد لشركة التمويل لدفعه للمورّد يختلف عن المبلغ المسجّل في إشعار التسوية. ما زال دين المورّد محتسباً على المبلغ المعتمد ولم يتغيّر. راجع الإشعار مقابل المستند، وصحّحه هنا إن كان قد أُدخل بشكل خاطئ.",
  ],
  SettlementAdviceRecorded: ["Advice records", "المسجّل في الإشعار"],
  SettlementAdviceApproved: ["Approved to pay", "المعتمد للدفع"],
  SettlementAdviceDifference: ["Difference", "الفرق"],
  FcChequeRegisteredNote: [
    "A finance company cheque is registered as this deal's payment.",
    "شيك شركة تمويل مسجّل كدفعة لهذه الصفقة.",
  ],
  FcChequeFaceLabel: ["Face amount printed on the cheque", "المبلغ المطبوع على وجه الشيك"],
  FcChequeFaceHelp: [
    "Type the amount exactly as printed on the instrument. It is never taken from the quote.",
    "اكتب المبلغ كما هو مطبوع على الشيك تمامًا. لا يؤخذ أبدًا من عرض السعر.",
  ],
  FcChequeFaceRequired: ["Enter the face amount printed on the cheque", "أدخل المبلغ المطبوع على الشيك"],
  FcCorrectExpectedPayment: ["Correct expected payment", "تصحيح الدفعة المتوقعة"],
  FcCorrectExpectedPaymentDesc: [
    "Withdraws the registered payment and its open cheque so the payment can be registered again correctly. A cheque that has been deposited or cleared cannot be withdrawn here.",
    "يسحب الدفعة المسجّلة وشيكها المفتوح لتتمكن من تسجيلها من جديد بالشكل الصحيح. لا يمكن سحب شيك تم إيداعه أو تحصيله من هنا.",
  ],
  FcCorrectReasonLabel: ["Why is the registered payment being corrected?", "ما سبب تصحيح الدفعة المسجّلة؟"],
  FcCorrectReasonPlaceholder: ["e.g. wrong bank or wrong face amount entered", "مثال: إدخال بنك أو مبلغ خاطئ"],
  FcCorrectExpectedPaymentDone: [
    "Expected payment withdrawn. Register it again to continue.",
    "تم سحب الدفعة المتوقعة. سجّلها من جديد للمتابعة.",
  ],
  FcAttestChequeFace: ["Record cheque face", "تسجيل مبلغ الشيك"],
  FcAttestChequeFaceDesc: [
    "This cheque was registered before its face amount was recorded. Enter the amount printed on it. The disbursement can only be confirmed when this equals the receipt.",
    "سُجّل هذا الشيك قبل تسجيل مبلغه. أدخل المبلغ المطبوع عليه. لا يمكن تأكيد الصرف إلا إذا ساوى المبلغ المستلم.",
  ],
  FcAttestDone: ["Cheque face recorded.", "تم تسجيل مبلغ الشيك."],
  FcAttestNoteLabel: ["Why is this face being attested?", "لماذا يُعتمد هذا المبلغ؟"],
  FcAttestNotePlaceholder: [
    "For example: read from the printed instrument in the file.",
    "مثال: قُرئ من الشيك المطبوع في الملف.",
  ],
  FcFaceAttestedBadge: ["Face attested by finance", "المبلغ معتمد من المالية"],
  FcCorrectNeededNotice: [
    "The registered cheque was returned or cancelled. Correct the expected payment, then register the new one.",
    "أُعيد الشيك المسجّل أو أُلغي. صحّح الدفعة المتوقعة ثم سجّل الدفعة الجديدة.",
  ],
  FcAccountingReviewNotice: [
    "This deal's cheque is marked cleared but the disbursement was never confirmed. Accounting must review it.",
    "شيك هذه الصفقة مُعلَّم كمُحصَّل لكن الصرف لم يُؤكَّد. يجب أن يراجعه المحاسب.",
  ],
  FcNeedsFinanceAttest: [
    "A finance manager must record this cheque face before the disbursement can be confirmed.",
    "يجب على مدير مالي تسجيل مبلغ هذا الشيك قبل تأكيد الصرف.",
  ],
  FcNeedsFinanceCorrect: [
    "A finance manager must correct the expected payment before a new one can be registered.",
    "يجب على مدير مالي تصحيح الدفعة المتوقعة قبل تسجيل دفعة جديدة.",
  ],
  FcNeedsRegisterPermission: [
    "Registering the expected payment needs the register-expected-payment permission. Ask a finance manager or sales manager.",
    "تسجيل الدفعة المتوقعة يتطلب صلاحية تسجيل الدفعة المتوقعة. اطلب من مدير مالي أو مدير مبيعات.",
  ],
  FcChequeFaceUnrecordedNotice: [
    "The face amount of this deal's cheque is not recorded, so the disbursement cannot be confirmed yet.",
    "مبلغ شيك هذه الصفقة غير مسجّل، لذا لا يمكن تأكيد الصرف بعد.",
  ],
  FcReRegisterNotice: [
    "No expected payment is registered on this closed deal. Register it to confirm the disbursement.",
    "لا توجد دفعة متوقعة مسجّلة على هذه الصفقة المغلقة. سجّلها لتأكيد الصرف.",
  ],
  FcDrawerLine: ["Drawer: {name}", "الساحب: {name}"],
  FcDrawerUnverified: ["Drawer unverified", "الساحب غير موثّق"],
  FcChequeBadge: ["Finance company cheque", "شيك شركة تمويل"],
  FcHandledFromDeal: ["Handled from the deal", "يُعالج من الصفقة"],
  FcSaleCancelFromDeal: [
    "This sale belongs to a financed deal. Cancel the deal from the deal screen.",
    "هذا البيع تابع لصفقة ممولة. ألغِ الصفقة من شاشة الصفقة.",
  ],
  FcOpenDeal: ["Open the deal", "افتح الصفقة"],
  CorrectSettlementAdvice: ["Correct the advice", "تصحيح الإشعار"],
  CorrectSettlementAdviceDescription: [
    "Corrects what was entered from the settlement advice. It does not change the approved purchase amount, which the supplier's debt and this deal's reported profit are both measured from.",
    "يصحّح ما أُدخل من إشعار التسوية. ولا يغيّر المبلغ المعتمد للشراء، فهو الأساس الذي يُحتسب عليه دين المورّد وربح هذه الصفقة معاً.",
  ],
  SettlementAdviceAmountLabel: ["Amount on the advice", "المبلغ في الإشعار"],
  SettlementAdviceReferenceLabel: ["Cheque or transfer reference", "رقم الشيك أو الحوالة"],
  SettlementAdviceDateLabel: ["Date paid", "تاريخ الدفع"],
  SettlementAdviceReasonLabel: ["Why the recorded advice was wrong", "سبب الخطأ في الإشعار المسجّل"],
  SettlementAdviceReasonPlaceholder: [
    "e.g. the amount was transposed when it was entered",
    "مثال: تبديل في ترتيب أرقام المبلغ عند الإدخال",
  ],
  SettlementAdviceReasonNote: [
    "Kept on the audit record. This changes evidence about a payment somebody else made, and the reason is the only account of it.",
    "يُحفظ في سجل التدقيق. هذا التعديل يغيّر دليلاً على دفعة قام بها طرف آخر، والسبب هو التوثيق الوحيد لها.",
  ],
  SaveCorrection: ["Save correction", "حفظ التصحيح"],
  SettlementAdviceCorrectionSaved: ["Correction saved", "تم حفظ التصحيح"],
  Unknown: ["Unknown", "غير معروف"],
  StatusLogHeading: ["Status history", "سجل الحالة"],
  DocumentsHeading: ["Documents", "المستندات"],
  DocumentRequired: ["Required", "مطلوب"],
  DocumentsComplete: ["complete", "مكتملة"],
  MoneyPanelHidden: ["You do not have permission to view this deal's figures.", "لا تملك صلاحية عرض أرقام هذه الصفقة."],
  SettleSupplierAction: ["Settle supplier", "تسوية المورد"],
  SupplierClaimDisputedGuidance: [
    "This claim is under dispute. Resolve the dispute before recording any money against it.",
    "هذه المطالبة قيد النزاع. سوِّ النزاع أولاً قبل تسجيل أي مبلغ عليها.",
  ],
  SettleSupplierTitle: ["Record what the supplier paid back", "تسجيل ما سدَّده المورد"],
  SettleSupplierDesc: [
    "The finance company paid {supplier} directly, so what remains is the dealership's margin on the deal. Record what {supplier} has actually paid back — not what is owed.",
    "شركة التمويل دفعت إلى {supplier} مباشرة، والمتبقي هو هامش المعرض على الصفقة. سجِّل ما سدَّده {supplier} فعلياً، لا ما هو مستحق عليه.",
  ],
  SupplierReceiptAmount: ["Amount received", "المبلغ المستلم"],
  SupplierStillOwed: ["Still owed", "المتبقي على المورد"],
  SupplierReceiptReference: ["Transfer or receipt reference", "رقم الحوالة أو الإيصال"],
  SupplierReceiptDate: ["Date received", "تاريخ الاستلام"],
  SupplierReceiptAccount: ["Received into", "أُودع في"],
  RecordReceipt: ["Record receipt", "تسجيل الاستلام"],
  // The button label is an instruction; a success toast that repeats it reads
  // as if nothing happened yet.
  ReceiptRecorded: ["Receipt recorded", "تم تسجيل الاستلام"],
  ReceiptAmountInvalid: ["Enter an amount greater than zero.", "أدخل مبلغاً أكبر من صفر."],
  ReceiptExceedsClaim: ["That is more than the supplier still owes.", "المبلغ أكبر من المتبقي على المورد."],
  SupplierSettledInFull: ["This claim is settled in full.", "تمت تسوية هذه المطالبة بالكامل."],
});

// Profit access and expense messages have different positions in the two catalogs.
export const dealCockpitEn = {
  ...dealCockpitStages.en,
  ...dealProfitAccess.en,
  ...dealProfitExpenses.en,
  ...dealCockpitMoney.en,
  ...customerReceiptMessages.en,
  ...dealSettlementMessages.en,
  ...cashDealCancelMessages.en,
};

export const dealCockpitAr = {
  ...dealCockpitStages.ar,
  ...dealProfitExpenses.ar,
  ...dealProfitAccess.ar,
  ...dealCockpitMoney.ar,
  ...customerReceiptMessages.ar,
  ...dealSettlementMessages.ar,
  ...cashDealCancelMessages.ar,
};
