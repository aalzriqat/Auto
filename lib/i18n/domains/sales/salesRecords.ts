import { defineBilingualMessages } from "../../defineBilingualMessages";

const saleFields = defineBilingualMessages({
  // Sales & F&I
  LogSale: ["Log Sale", "تسجيل بيع"],
  SaleDetails: ["Sale Details", "تفاصيل البيع"],
  SalePrice: ["Sale Price", "سعر البيع"],
  SalePriceJOD: ["Sale Price (JOD)", "سعر البيع (دينار)"],
});

const saleCash = defineBilingualMessages({
  Cash: ["Cash", "نقدي"],
});

const saleFinancingInputs = defineBilingualMessages({
  TaxRate: ["Tax Rate (%)", "نسبة الضريبة (%)"],
  TaxAmount: ["Tax Amount", "مبلغ الضريبة"],
  DealerFees: ["Dealer Fees", "رسوم المعرض"],
  DownPayment: ["Down Payment", "الدفعة المقدمة"],
  DownPaymentMustBeBelowPrice: [
    "The down payment must be less than the sale price for a financed quote.",
    "يجب أن تكون الدفعة المقدمة أقل من سعر البيع لعروض التمويل.",
  ],
  FinanceOptionsAwaitValidDownPayment: [
    "Financing options appear once the down payment is below the sale price.",
    "تظهر خيارات التمويل عندما تصبح الدفعة المقدمة أقل من سعر البيع.",
  ],
  TradeInVehicle: ["Trade-in Vehicle", "مركبة الاستبدال"],
  TradeInValue: ["Trade-in Value", "قيمة الاستبدال"],
  FinancingType: ["Financing Type", "نوع التمويل"],
});

export const salesFinancingLimitMessages = defineBilingualMessages({
  MaxFinancing: ["Max Allowed", "الحد الأعلى المسموح"],
  MinDownPayment: ["Min Down Payment", "الحد الأدنى للدفعة"],
  Conditions: ["Conditions / Required Docs", "الشروط / المستندات المطلوبة"],
  IncreaseDownPayment: ["Increase Down Payment", "زيادة الدفعة الأولى"],
  ExceedsLimit: ["Exceeds Financing Limit", "يتجاوز حد التمويل"],
  ExceedsFinancingLimit: [
    "Financed amount exceeds the financing company's valuation limit. Please increase the down payment.",
    "المبلغ الممول يتجاوز حد تقييم شركة التمويل. الرجاء زيادة الدفعة الأولى.",
  ],
  NotSet: ["Not Set", "غير محدد"],
  FinanceCompanyValuation: ["Financing Company Valuation", "تقييم شركة التمويل"],
  SelectSave: ["Select & Save", "اختيار وحفظ"],
});

const saleFinancingTerms = defineBilingualMessages({
  Financed: ["Financed", "تقسيط"],
  Lease: ["Lease", "تأجير"],
  LeaseRetired: ["Lease (retired)", "تأجير (متوقف)"],
  LoanAmount: ["Loan Amount", "مبلغ القرض"],
  APR: ["APR (%)", "نسبة الربح (%)"],
  TermMonths: ["Term (Months)", "المدة (أشهر)"],
  FinancingTermMonths: ["Term (months)", "مدة التمويل (بالأشهر)"],
  Warranty: ["Extended Warranty", "تمديد الضمان"],
  WarrantyCost: ["Warranty Cost (owed to provider)", "تكلفة الضمان (مستحقة للمزود)"],
  WarrantyTermMonths: ["Warranty Term (Months)", "مدة الضمان (أشهر)"],
  GAPInsurance: ["GAP Insurance", "تأمين GAP"],
  GAPCost: ["GAP Cost (owed to provider)", "تكلفة GAP (مستحقة للمزود)"],
  GAPTermMonths: ["GAP Term (Months)", "مدة GAP (أشهر)"],
  EstMonthlyPayment: ["Est. Monthly Payment", "القسط الشهري المتوقع"],
});

const saleListAndQuoteActions = defineBilingualMessages({
  // Sales Page
  SalesRecords: ["Sales Records", "سجلات المبيعات"],
  SalesRecordsDesc: [
    "Log and manage vehicle sales and track revenue.",
    "تسجيل وإدارة مبيعات المركبات وتتبع الإيرادات.",
  ],
  SearchSales: ["Search by customer, vehicle, or salesperson...", "ابحث عن طريق العميل، المركبة، أو مسؤول المبيعات..."],
  Date: ["Date", "التاريخ"],
  Salesperson: ["Salesperson", "مسؤول المبيعات"],
  Price: ["Price", "السعر"],
  Status: ["Status", "الحالة"],
  Actions: ["Actions", "الإجراءات"],
  Cancelled: ["Cancelled", "ملغى"],
  SaleRemovedSuccess: ["Sale deleted successfully", "تم حذف سجل البيع بنجاح"],
  SaleRemoveFail: ["Failed to delete sale", "فشل حذف سجل البيع"],
  LoadingSales: ["Loading sales...", "جاري تحميل سجلات المبيعات..."],
  NoSalesFound: ["No sales found.", "لم يتم العثور على مبيعات."],
  BillOfSaleGenerated: ["Bill of Sale generated", "تم إنشاء فاتورة البيع"],
  FailedGeneratePDF: ["Failed to generate PDF", "فشل إنشاء ملف PDF"],
  DeleteSaleRecord: ["Delete Sale Record", "حذف سجل البيع"],
  DeleteSaleConfirm: [
    "Are you sure you want to delete this sale? This action cannot be undone. If you just want to cancel the sale, use the Edit button to change its status to CANCELLED.",
    "هل أنت متأكد أنك تريد حذف عملية البيع هذه؟ لا يمكن التراجع عن هذا الإجراء. إذا كنت ترغب فقط في إلغاء البيع، استخدم زر التعديل لتغيير حالته إلى ملغى.",
  ],
  DeletePermanently: ["Delete Permanently", "حذف نهائي"],
  CreateQuote: ["Create Quote", "إنشاء عرض سعر"],
  ViewSaleTrail: ["View sale trail", "عرض مسار البيع"],
  SaleTrail: ["Sale Trail", "مسار البيع"],
  SaleTrailDesc: ["Everything this sale triggered across the system", "كل ما نتج عن هذا البيع في النظام"],
  SaleTrailPendingNote: [
    "This sale hasn't been completed yet, so these steps haven't run.",
    "لم تكتمل عملية البيع بعد، لذا لم تُنفَّذ هذه الخطوات.",
  ],
  StepSaleCreated: ["Sale recorded", "تم تسجيل البيع"],
  StepVehicleSold: ["Vehicle marked as sold", "تم تحديث حالة المركبة إلى مباعة"],
  StepDepositApplied: ["Deposit applied", "تم تطبيق العربون"],
  StepGLPosted: ["Accounting entry posted", "تم ترحيل القيد المحاسبي"],
  StepCommissionGLPosted: ["Commission accrual posted", "تم ترحيل قيد استحقاق العمولة"],
  StepReceivableCreated: ["Customer invoice created", "تم إنشاء فاتورة العميل"],
  StepPaymentAllocated: ["Payment allocated to invoice", "تم تخصيص الدفعة للفاتورة"],
  StepSupplierPayable: ["Supplier payable recorded", "تم تسجيل مستحقات المورد"],
  StepCommissionAccrued: ["Commission accrued", "تم استحقاق العمولة"],
  StepCommissionAmountSet: ["Commission amount set", "تم تحديد مبلغ العمولة"],
  StepCommissionAccrualReversed: ["Commission accrual reversed", "تم عكس استحقاق العمولة"],
  StepCommissionPaid: ["Commission paid", "تم دفع العمولة"],
  StepLeadClosed: ["Lead closed as won", "تم إغلاق العميل المحتمل كصفقة رابحة"],
  StepManagersNotified: ["Managers notified", "تم إشعار المدراء"],
  JournalNumberLabel: ["Journal", "القيد"],
  SoldBy: ["Sold by", "باعها"],
  SaleUpdatedSuccess: ["Sale updated successfully", "تم تحديث تفاصيل البيع بنجاح"],
  SaleRecordedSuccess: ["Sale recorded successfully!", "تم تسجيل البيع بنجاح!"],
  SaleLogFail: ["Failed to log sale", "فشل تسجيل البيع"],
  CashDeal: ["Cash Deal", "دفع نقدي"],
  GeneratingQuote: ["Generating...", "جاري الإنشاء..."],
  CustomerSearchPlaceholder: ["Search by name, phone, or national ID…", "ابحث بالاسم أو الهاتف أو الرقم الوطني…"],
  NoCustomersFoundWizard: ["No customers found.", "لم يتم العثور على عملاء."],
  CreateNewCustomerBtn: ["Create a new customer", "إنشاء عميل جديد"],
  QuoteSavedSuccess: ["Quote generated and saved!", "تم إنشاء وحفظ عرض السعر!"],
});

const quoteSaveError = defineBilingualMessages({
  QuoteSaveFail: ["Failed to save quote", "فشل في حفظ عرض السعر"],
});

const saleQuoteMessages = defineBilingualMessages({
  QuoteGeneratedSuccess: ["Quote Generated Successfully!", "تم إنشاء عرض السعر بنجاح!"],
  QuoteSavedLinkedTo: ["The quote has been saved and is now linked to", "تم حفظ عرض السعر وربطه بـ"],
  DownloadPDFQuote: ["Download PDF Quote", "تحميل PDF لعرض السعر"],
  DoneClose: ["Done & Close", "تم وإغلاق"],
  RecordDeposit: ["Record Deposit", "تسجيل عربون"],
  RecordAdditionalDeposit: ["Record another deposit", "تسجيل عربون إضافي"],
  RequestAdditionalDeposit: ["Request another deposit", "طلب عربون إضافي"],
  DepositReceiptHistory: ["Deposit receipts", "سندات قبض العربون"],
  DepositReceiptUnavailable: ["Receipt voucher unavailable", "سند القبض غير متاح"],
  DepositReceiptVoided: ["Voided", "ملغى"],
  RecordDepositDesc: [
    "Record the deposit the customer paid. The vehicle will show as reserved until the deal completes or the deposit is released.",
    "سجّل العربون الذي دفعه العميل. ستظهر المركبة محجوزة إلى أن تكتمل الصفقة أو يُفرج عن العربون.",
  ],
  DepositRecordedSuccess: ["Deposit recorded — vehicle is now on hold", "تم تسجيل العربون — المركبة الآن محجوزة"],
  RequestDeposit: ["Request deposit", "طلب تسجيل عربون"],
  RequestDepositDesc: [
    "Ask a manager or accountant to record the deposit the customer is handing over. Nothing is held and no money is recorded until they confirm they received it.",
    "اطلب من المدير أو المحاسب تسجيل العربون الذي يسلّمه العميل. لن يُحجز شيء ولن يُسجَّل أي مبلغ قبل أن يؤكد استلامه.",
  ],
  DepositRequestedSuccess: [
    "Deposit requested — waiting for a manager or accountant to confirm receipt",
    "تم إرسال طلب العربون — بانتظار تأكيد الاستلام من المدير أو المحاسب",
  ],
  DepositRequestedLabel: ["Deposit requested — awaiting confirmation", "تم طلب العربون — بانتظار التأكيد"],
  DepositChooseMethod: ["How was it received?", "كيف تم الاستلام؟"],
  DepositBankLabel: ["Bank that received the deposit", "البنك الذي استلم العربون"],
  DepositBankChoose: ["Choose the receiving bank", "اختر البنك المستلم"],
  DepositNoBank: [
    "Create an active bank account in this currency before recording a bank deposit.",
    "أنشئ حساباً بنكياً نشطاً بهذه العملة قبل تسجيل عربون بنكي.",
  ],
  DepositTooManyBanks: [
    "Too many bank accounts to choose from. Ask an administrator to narrow the list.",
    "عدد الحسابات البنكية كبير جداً. اطلب من المسؤول تقليص القائمة.",
  ],
  DepositMethodRequired: [
    "Choose how the deposit was received (cash, bank transfer, card or cheque) to continue.",
    "اختر طريقة استلام العربون (نقداً أو تحويل بنكي أو بطاقة أو شيك) للمتابعة.",
  ],
  RefundChooseMethod: ["How is it being refunded?", "كيف سيتم الرد؟"],
  RefundMethodRequired: [
    "Choose how the refund is being paid (cash, bank transfer, card or cheque) to continue.",
    "اختر طريقة رد المبلغ (نقداً أو تحويل بنكي أو بطاقة أو شيك) للمتابعة.",
  ],
  PayoutUnconfirmedTitle: [
    "An earlier payout for this deposit may already have gone through.",
    "قد تكون دفعة سابقة لهذا العربون قد نُفذت بالفعل.",
  ],
  PayoutUnconfirmedBody: [
    "Check this deposit's refund history first. Then retry the earlier payout exactly as it was, or dismiss it if you have confirmed it did not go through.",
    "تحقق أولاً من سجل الرد لهذا العربون. ثم أعد المحاولة السابقة كما هي، أو تجاهلها إذا تأكدت أنها لم تُنفذ.",
  ],
  PayoutUnconfirmedAttempt: ["Earlier attempt:", "المحاولة السابقة:"],
  PayoutUnconfirmedRetry: ["Retry the earlier payout", "إعادة الدفعة السابقة"],
  PayoutUnconfirmedDismiss: ["It did not go through - dismiss", "لم تُنفذ - تجاهل"],
  MoneyMethodChoose: ["Choose a payment method", "اختر طريقة الدفع"],
  MoneyMethodRequired: [
    "Choose the payment method the money actually moved by to continue.",
    "اختر طريقة الدفع التي تحرّك بها المبلغ فعلاً للمتابعة.",
  ],
  DepositAskManagerOrAccountant: [
    "Only a manager or accountant can change held deposit money. Ask one of them to do this.",
    "المدير أو المحاسب فقط يمكنه تعديل مبالغ العربون المحجوزة. اطلب منه تنفيذ ذلك.",
  ],
  DepositRequestsTitle: ["Deposit requests", "طلبات العربون"],
  DepositRequestStatus_PENDING: [
    "Requested — awaiting confirmation (counts as nothing paid yet)",
    "مطلوب — بانتظار التأكيد (لا يُحتسب كمبلغ مدفوع بعد)",
  ],
  DepositRequestStatus_CONFIRMED: ["Confirmed — deposit recorded", "تم التأكيد — سُجّل العربون"],
  DepositRequestStatus_REJECTED: ["Rejected", "مرفوض"],
  DepositRequestStatus_WITHDRAWN: ["Withdrawn", "تم سحب الطلب"],
  DepositRequestAwaitingManager: [
    "A manager or accountant will confirm once the money is received. You can withdraw the request if it is no longer needed.",
    "سيؤكد المدير أو المحاسب بعد استلام المبلغ. يمكنك سحب الطلب إن لم يعد لازماً.",
  ],
  DepositRequestWithdrawAction: ["Withdraw request", "سحب الطلب"],
  DepositRequestConfirmAction: ["Confirm receipt", "تأكيد الاستلام"],
  DepositRequestRejectAction: ["Reject", "رفض"],
  DepositRequestReceivedConfirm: ["Money received — record deposit", "تم استلام المبلغ — سجّل العربون"],
  DepositRequestRejectReason: ["Why is it being rejected?", "ما سبب الرفض؟"],
  DepositRequestConfirmedToast: [
    "Deposit recorded — the vehicle is now on hold",
    "تم تسجيل العربون — المركبة الآن محجوزة",
  ],
  DepositRequestRejectedToast: ["Deposit request rejected", "تم رفض طلب العربون"],
  DepositRequestWithdrawnToast: ["Deposit request withdrawn", "تم سحب طلب العربون"],
  DepositRequestsQueueTitle: ["Deposits waiting for confirmation", "عربونات بانتظار التأكيد"],
  DepositRequestsQueueEmpty: ["No deposits are waiting for confirmation.", "لا توجد عربونات بانتظار التأكيد."],
  DepositRequestsQueueDesc: [
    "Salespeople asked to record these deposits. Confirm only once the money has actually been received, and say how.",
    "طلب مندوبو المبيعات تسجيل هذه العربونات. أكّد فقط بعد استلام المبلغ فعلاً، وحدد طريقة الاستلام.",
  ],
  DealDepositRequestPendingTitle: [
    "A deposit request is waiting on this deal",
    "يوجد طلب عربون بانتظار القرار على هذه الصفقة",
  ],
  DealDepositRequestPendingReadonly: [
    "The deal cannot be finalized or cancelled until a manager or accountant confirms receipt or rejects this request. Ask one of them, or withdraw it if it is no longer needed.",
    "لا يمكن إنهاء الصفقة أو إلغاؤها حتى يؤكد المدير أو المحاسب استلام المبلغ أو يرفض الطلب. اطلب منه ذلك، أو اسحب الطلب إن لم يعد لازماً.",
  ],
  DepositRecorded: ["Deposit Recorded ✓", "تم تسجيل العربون ✓"],
  SubmitSale: ["Submit Sale", "إرسال البيع"],
  SaleCompleted: ["Sale Completed ✓", "تم البيع ✓"],
  SaleCompletedSuccess: ["Cash sale completed successfully", "تم إتمام البيع النقدي بنجاح"],
  // Where completing a cash sale now sends the operator: the deal's own screen,
  // not the sales list. One per car when the quote completed several.
  OpenDeal: ["Open Deal", "فتح الصفقة"],
  DealsCreatedForEachVehicle: ["A deal was created for each vehicle", "تم إنشاء صفقة لكل مركبة"],
  StartFinanceApplication: ["Start Finance Application", "بدء طلب التمويل"],
  ViewApplication: ["View Application →", "عرض الطلب ←"],
  ApplicationStartedSuccess: ["Finance application started successfully", "تم بدء طلب التمويل بنجاح"],
  // SCRUM-404: the wizard records the AutoFlow-calculated quotation it shows.
  StartApplicationRecordQuotation: ["Start application & record quotation", "بدء الطلب وتسجيل عرض السعر"],
  CreationQuotationTo: ["Quotation to {company}:", "عرض السعر إلى {company}:"],
  CreationQuotationCalculated: [
    "AutoFlow calculation — starting the application records it as the quotation submitted",
    "حساب AutoFlow — بدء الطلب يسجّله كعرض السعر المقدَّم لشركة التمويل",
  ],
  CreationQuotationManualCompany: [
    "This finance company is entered manually, so AutoFlow doesn't calculate its quotation.",
    "شركة التمويل هذه مُدخلة يدويًا، لذلك لا يحسب AutoFlow عرض سعرها.",
  ],
  CreationQuotationNotRecorded: [
    "Quotation not recorded now — it can be recorded on the deal page by someone with finance-application access.",
    "لم يُسجَّل عرض السعر الآن — يمكن تسجيله من صفحة الصفقة بواسطة من لديه صلاحية طلبات التمويل.",
  ],
  CreationQuotationOffsetRuleUnknown: [
    "{company}'s first-payment rule wasn't confirmed in Finance Settings when this quote was created, so AutoFlow can't calculate it. It can be recorded on the deal page. Once the rule is set to Yes, new quotes can be calculated automatically when their other details are complete.",
    "لم تكن قاعدة الدفعة الأولى لشركة {company} مؤكَّدة في إعدادات التمويل عند إنشاء عرض السعر هذا، لذلك لا يحسبه AutoFlow. يمكن تسجيله من صفحة الصفقة. بعد ضبط القاعدة على «نعم» يمكن حساب عروض الأسعار الجديدة تلقائيًا متى اكتملت بياناتها الأخرى.",
  ],
});

const saleDialogMessages = defineBilingualMessages({
  SmartQuoteComparison: ["Smart Quote Comparison", "مقارنة عروض الأسعار الذكية"],
  ExecutionFeesNotConfigured: [
    "Execution Fees are not configured for this finance company.",
    "مصاريف التنفيذ غير مُعدّة لشركة التمويل هذه.",
  ],
  FeesNotConfigured: ["Fees not configured", "المصاريف غير مُعدّة"],
  ConfigureFeesInSettings: [
    "Configure Execution Fees in Finance Settings.",
    "قم بإعداد مصاريف التنفيذ من إعدادات التمويل.",
  ],
  EnterExecutionFees: ["Enter Execution Fees", "أدخل مصاريف التنفيذ"],
  ExecutionFeesRequired: [
    "Execution fees must be configured (enter 0 if none).",
    "يجب إعداد مصاريف التنفيذ (أدخل 0 إذا لم توجد).",
  ],
  VehiclePriceJOD: ["Vehicle Price (JOD)", "سعر المركبة (دينار اردني)"],
  TotalToPay: ["Total to Pay", "الإجمالي للدفع"],
  FinancedAmount: ["Financed Amount", "المبلغ الممول"],
  TotalProfit: ["Total Profit", "إجمالي الربح"],
  Takaful: ["Takaful", "تكافل"],
  Rate: ["Rate", "نسبة"],
  // Sale Dialog
  EditSale: ["Edit Sale", "تعديل البيع"],
  UpdateSaleDesc: [
    "Update sale details. If you cancel it, the vehicle will be marked as available again.",
    "تحديث تفاصيل البيع. إذا قمت بإلغائه، ستصبح المركبة متاحة مرة أخرى.",
  ],
  AddSaleDesc: [
    "Record a new vehicle sale. This will automatically mark the vehicle as SOLD and close related leads.",
    "تسجيل بيع مركبة جديد. سيتم تحويل حالة المركبة إلى مباعة وإغلاق الطلبات المرتبطة تلقائيًا.",
  ],
  VehicleAndCustomer: ["Vehicle & Customer", "المركبة والعميل"],
  SelectStatus: ["Select status", "اختر الحالة"],
  PendingStatus: ["Pending (Financing/Paperwork)", "قيد الانتظار (تمويل / أوراق)"],
  CompletedStatus: ["Completed (Delivered)", "مكتمل (تم التسليم)"],
  CancelledStatus: ["Cancelled (Refunded/Backed out)", "ملغى (مسترجع / تراجع)"],
  PricingAndFees: ["Pricing & Fees", "التسعير والرسوم"],
  // Consigned (SOURCED) sale settlement — see ConsignedSettlementSection.
  // Multi-vehicle reservation-deposit allocation — see DepositAllocationPanel.
  // تسوية المركبة بالأمانة (SOURCED) — انظر ConsignedSettlementSection.
  // توزيع العربون على مركبات العرض — انظر DepositAllocationPanel.
  DepositAllocation: ["Deposit allocation", "توزيع العربون"],
  DepositAllocationDesc: [
    "This quote covers more than one vehicle and carries one reservation deposit of {amount}. Record how much of it belongs to each vehicle — the split is the customer's decision and cannot be worked out from the prices.",
    "يشمل هذا العرض أكثر من مركبة ويحمل عربونًا واحدًا بقيمة {amount}. سجّل حصة كل مركبة منه — فالتوزيع قرار العميل ولا يمكن استنتاجه من الأسعار.",
  ],
  DepositAllocationBlocking: [
    "No vehicle on this quote can be sold until its share of the deposit is recorded.",
    "لا يمكن بيع أي مركبة في هذا العرض قبل تسجيل حصتها من العربون.",
  ],
  DepositAllocationRemaining: ["{amount} left to allocate", "متبقٍ للتوزيع {amount}"],
  DepositAllocationOver: ["{amount} more than the deposit", "{amount} زيادة عن العربون"],
  DepositAllocationRemainderNote: [
    "Anything left unallocated stays a customer deposit on the quote. It is not applied to any sale until it is allocated or resolved.",
    "ما يبقى دون توزيع يظل عربونًا للعميل على العرض، ولا يُطبَّق على أي عملية بيع حتى يُوزَّع أو تُحسم معالجته.",
  ],
  DepositAllocationSuggest: ["Suggest a split", "اقترح توزيعًا"],
  DepositAllocationSave: ["Save allocation", "حفظ التوزيع"],
  DepositAllocationSaved: ["Deposit allocation saved", "تم حفظ توزيع العربون"],
  DepositAllocationApplied: ["applied", "مُطبَّق"],
  QuotedAt: ["Quoted at", "السعر في العرض"],
  ConsignedSaleSettlement: ["Consigned Vehicle — Supplier Settlement", "مركبة بالأمانة — تسوية المورّد"],
  ConsignedSaleSettlementDesc: [
    "This car belongs to {supplier}. The dealership is selling it as his agent and keeps only its margin. Record where the buyer's money went — it decides who owes whom.",
    "هذه المركبة ملك {supplier}. المعرض يبيعها بالوكالة عنه ولا يحتفظ إلا بهامشه. سجّل أين ذهبت نقود المشتري — فهي التي تحدد من يدين لمن.",
  ],
  SupplierSettlementRoute: ["Where the buyer paid", "أين دفع المشتري"],
  RouteThroughDealership: ["Through the dealership", "عن طريق المعرض"],
  RouteThroughDealershipHint: ["The buyer paid the dealership the full price.", "دفع المشتري كامل المبلغ للمعرض."],
  RouteDirectToSupplier: ["Direct to the supplier", "مباشرة إلى المورّد"],
  RouteDirectToSupplierHint: [
    "The buyer paid the supplier. The dealership never handled the money.",
    "دفع المشتري للمورّد، ولم يستلم المعرض المبلغ إطلاقًا.",
  ],
  UnnamedFinanceProvider: ["Finance provider (not named)", "جهة التمويل (غير مسمّاة)"],
  NotRecorded: ["Not recorded", "غير مسجّل"],
  LeaseFinancing: ["Lease", "تأجير تمويلي"],
  CashOrDirect: ["Cash / Direct", "نقدي / مباشر"],
  RouteDirectUnavailableNoExternalFinancier: [
    "No outside financier on this deal, so nobody but the dealership pays the supplier.",
    "لا توجد جهة تمويل خارجية في هذه الصفقة، فلا أحد غير المعرض يدفع للمورّد.",
  ],
  RouteDirectUnavailableLease: [
    "The leasing provider is not recorded on this deal, so a payment to the supplier could not be attributed to anyone.",
    "جهة التأجير غير مسجّلة في هذه الصفقة، فلا يمكن إسناد الدفعة إلى أي جهة.",
  ],
  RouteDirectUnavailableUnnamedProvider: [
    "The finance provider is not named on this deal, so a payment to the supplier could not be attributed to anyone.",
    "اسم جهة التمويل غير مسجّل في هذه الصفقة، فلا يمكن إسناد الدفعة إلى أي جهة.",
  ],
  GrossTransactionValue: ["Gross transaction value", "إجمالي قيمة الصفقة"],
  SupplierEntitlement: ["{supplier} is entitled to", "مستحق {supplier}"],
  DealerGrossMargin: ["Dealership margin", "هامش المعرض"],
  TheDealership: ["The dealership", "المعرض"],
  TheSupplier: ["the supplier", "المورّد"],
  ConsignedThroughConsequence: [
    "The dealership invoices the customer for the full price and owes {supplier} his share. Settle it from Supplier Payables.",
    "يصدر المعرض فاتورة بكامل المبلغ على العميل، ويبقى مدينًا لـ{supplier} بحصته. سدّدها من ذمم الموردين الدائنة.",
  ],
  ConsignedDirectConsequence: [
    "The customer is invoiced nothing for the car. {supplier} is holding the dealership's margin until he settles it — collect it from Supplier Receivables.",
    "لا يُفوتر العميل بثمن المركبة. يحتفظ {supplier} بهامش المعرض حتى يسدّده — حصّله من ذمم الموردين المدينة.",
  ],
});

const supplierCostWarning = defineBilingualMessages({
  ConsignedNoSupplierCost: [
    "No supplier amount is recorded for this vehicle, so the dealership's margin cannot be determined and the sale cannot be completed. Record the agreed supplier amount, or convert the vehicle to dealer-owned stock first.",
    "لا يوجد مبلغ مورّد مسجّل لهذه المركبة، لذا لا يمكن تحديد هامش المعرض ولا إتمام البيع. سجّل المبلغ المتفق عليه مع المورّد، أو حوّل المركبة إلى ملكية المعرض أولًا.",
  ],
});

const saleDepositMessages = defineBilingualMessages({
  DepositSettlementTitle: ["The reservation deposit on this deal", "العربون في هذه الصفقة"],
  DepositSettlementDesc: [
    "The customer already paid this against the deal. Confirm it forms part of the final settlement and the rest is worked out for you.",
    "دفع العميل هذا المبلغ مقدمًا على الصفقة. أكّد أنه جزء من التسوية النهائية، وسيُحتسب الباقي تلقائيًا.",
  ],
  DepositSettlementConfirm: [
    "This deposit forms part of the final settlement of this deal",
    "هذا العربون جزء من التسوية النهائية لهذه الصفقة",
  ],
  DepositSettlementHeldAmount: ["Deposit held on this car", "العربون المحجوز على هذه المركبة"],
  DepositSettlementRequired: [
    "This sale cannot be completed until it is recorded what happens to this deposit.",
    "لا يمكن إتمام هذا البيع قبل تسجيل ما سيحدث لهذا العربون.",
  ],
  DepositSettlementCustomerOwes: ["The customer would still owe", "يبقى على العميل"],
  DepositSettlementSupplierOwes: ["{supplier} would still owe the dealership", "يبقى على {supplier} للمعرض"],
  DepositSettlementNotDecided: [
    "This car's share of the deposit has not been decided yet. Record the split above first.",
    "لم تُحدَّد بعد حصة هذه المركبة من العربون. سجّل التوزيع أعلاه أولًا.",
  ],
  DepositSettlementUnavailable: ["This deposit cannot be treated that way", "لا يمكن معالجة هذا العربون بهذه الطريقة"],
  DepositSettlementConfirmAllLines: [
    "This deposit decision applies to the whole deal, so confirm it on every vehicle on this quote — or on none of them.",
    "قرار العربون يسري على الصفقة كاملة، لذا أكّده على كل مركبة في هذا العرض — أو لا تؤكّده على أي منها.",
  ],
});

const saleDialogFields = defineBilingualMessages({
  Taxes: ["Taxes (JOD)", "الضرائب (دينار اردني)"],
  ConsignedTaxUnsupported: [
    "This car is the supplier's, and tax on an agency sale has no agreed treatment yet — so the sale cannot be posted with it. Clear the tax to record the sale, or sell the car as dealership stock.",
    "هذه المركبة ملك المورّد، ولا توجد بعد معالجة متفق عليها لضريبة البيع بالوكالة، لذا لا يمكن ترحيل البيع بوجودها. امسح الضريبة لتسجيل البيع، أو بِع المركبة كمخزون للمعرض.",
  ],
  FinancingAndTradeIn: ["Financing & Trade-In", "التمويل والاستبدال"],
  SelectTradeIn: ["Select trade-in (optional)", "اختر مركبة الاستبدال (اختياري)"],
  None: ["None", "لا يوجد"],
  VehicleMustBeAdded: ["Vehicle must be added to inventory first.", "يجب إضافة المركبة إلى المخزون أولاً."],
  SelectType: ["Select type", "اختر النوع"],
  DealStructuring: ["F&I Deal Structuring", "هيكلة صفقات التمويل والتأمين (F&I)"],
  Cancel: ["Cancel", "إلغاء"],
  Saving: ["Saving...", "جاري الحفظ..."],
  SaveChanges: ["Save Changes", "حفظ التغييرات"],
});

// Finance limits appear under different sections in the ordered EN and AR catalogs.
export const salesRecordsEn = {
  ...saleFields.en,
  ...saleCash.en,
  ...saleFinancingInputs.en,
  ...salesFinancingLimitMessages.en,
  ...saleFinancingTerms.en,
  ...saleListAndQuoteActions.en,
  ...quoteSaveError.en,
  ...saleQuoteMessages.en,
  ...saleDialogMessages.en,
  ...supplierCostWarning.en,
  ...saleDepositMessages.en,
  ...saleDialogFields.en,
};

export const salesRecordsAr = {
  ...saleFields.ar,
  SaleDate: "تاريخ البيع",
  ...saleFinancingInputs.ar,
  ...saleCash.ar,
  ...saleFinancingTerms.ar,
  PrintBillOfSale: "طباعة فاتورة البيع",
  ...saleListAndQuoteActions.ar,
  ...saleQuoteMessages.ar,
  ...quoteSaveError.ar,
  ...saleDialogMessages.ar,
  ...saleDepositMessages.ar,
  ...supplierCostWarning.ar,
  ...saleDialogFields.ar,
};
