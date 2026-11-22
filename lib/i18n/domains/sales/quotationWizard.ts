import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * SCRUM-628 (QA wave 2A): strings the quote wizard rendered in English whatever
 * the language. "Create & Select" is bound by the English E2E suites — keep it.
 */
export const quoteWizardQaMessages = defineBilingualMessages({
  NewCustomerFormTitle: ["New Customer", "عميل جديد"],
  CreateAndSelectCustomer: ["Create & Select", "إنشاء واختيار"],
  CustomerCreatedSuccess: ["Customer created successfully", "تم إنشاء العميل بنجاح"],
  CustomerFirstNameRequired: ["First name is required", "الاسم الأول مطلوب"],
  CustomerLastNameRequired: ["Last name is required", "الاسم الأخير مطلوب"],
  CustomerEmailInvalid: ["Enter a valid email address", "أدخل بريدًا إلكترونيًا صحيحًا"],
  CustomerFirstNamePlaceholder: ["Ahmad", "أحمد"],
  CustomerLastNamePlaceholder: ["Al-Rashid", "الرشيد"],
  CustomerNationalIdPlaceholder: ["ID number", "رقم الهوية"],
  CustomerAddressPlaceholder: ["City, Country", "المدينة، الدولة"],
  PleaseSelectFinanceCompany: ["Please select a financing company", "يرجى اختيار شركة التمويل"],
  FinanceCompanyResetByEdit: [
    "The quote terms changed, so the finance company choice was cleared. Choose a company again from the updated offers.",
    "تغيّرت شروط العرض، لذلك أُلغي اختيار شركة التمويل. اختر الشركة مجددًا من العروض المحدّثة.",
  ],
  CustomerStatusesLoading: ["Loading customer statuses…", "جارٍ تحميل حالات العميل…"],
  DepositAmountInvalid: [
    "Enter the amount as a number, without a sign, and with no more decimals than the currency allows.",
    "أدخل المبلغ كرقم، دون إشارة، وبعدد منازل عشرية لا يتجاوز ما تسمح به العملة.",
  ],
  DepositAmountPositive: ["The amount must be greater than zero.", "يجب أن يكون المبلغ أكبر من صفر."],
  QuoteWizardComplete: ["Quote created", "تم إنشاء العرض"],
  NoRequiredDocuments: [
    "This finance company has no required documents set up.",
    "لا توجد مستندات مطلوبة معرّفة لدى شركة التمويل هذه.",
  ],
  // SCRUM-656: the wizard's own profit-approval alerts. The English wording is
  // bound by playwright/tests/profit-approval.spec.ts — keep it.
  WizardProfitApprovalRequiredTitle: ["Approval Required", "مطلوب اعتماد"],
  WizardProfitApprovalRequiredBody: [
    "At this price the uplift over the list price ({margin}) is below this vehicle's Minimum Price Uplift ({minimum}). This check does not prevent a loss-making sale.",
    "عند هذا السعر، الزيادة فوق سعر القائمة ({margin}) أقل من الحد الأدنى للزيادة فوق سعر القائمة لهذه المركبة ({minimum}). هذا الفحص لا يمنع بيعاً بخسارة.",
  ],
  WizardProfitApprovalPending: [
    "Approval request is currently pending. Please wait for a manager.",
    "طلب الاعتماد قيد الانتظار. يرجى انتظار قرار المدير.",
  ],
  WizardProfitApprovalRejected: [
    "Your request for this price was rejected. Please raise the price or request again.",
    "رُفض طلبك لهذا السعر. يرجى رفع السعر أو إعادة الطلب.",
  ],
  WizardProfitApprovalRequestAction: ["Request Price Uplift Approval", "طلب اعتماد الزيادة فوق سعر القائمة"],
  WizardProfitApprovalRequesting: ["Requesting...", "جارٍ الإرسال…"],
  WizardProfitApprovalRequestFailed: [
    "Could not send the approval request. Please try again.",
    "تعذّر إرسال طلب الاعتماد. يرجى المحاولة مرة أخرى.",
  ],
  WizardProfitApprovedTitle: ["Price Uplift Approved", "تم اعتماد الزيادة فوق سعر القائمة"],
  WizardProfitApprovedBody: [
    "Management approved this sale price (uplift over the list price: {margin}). You may proceed.",
    "اعتمدت الإدارة سعر البيع هذا (الزيادة فوق سعر القائمة: {margin}). يمكنك المتابعة.",
  ],
});

/**
 * SCRUM-681: why the record-quotation dialog has no calculated figure, for the
 * reasons the operator can act on. The rule is the one applied to the deal — its
 * snapshot, which may have been frozen on the quote — so the copy names no moment.
 */
export const quotationUnavailableMessages = defineBilingualMessages({
  QuotationUnavailableOffsetRuleUnknown: [
    "The finance company's first-payment rule that applies to this deal isn't confirmed, so AutoFlow can't calculate a figure. Record the amount that was actually sent.",
    "قاعدة الدفعة الأولى لشركة التمويل المطبَّقة على هذه الصفقة غير مؤكَّدة، لذلك لا يستطيع أوتوفلو احتساب رقم. سجِّل المبلغ الذي أُرسل فعلياً.",
  ],
  QuotationUnavailableOffsetRuleDoesNotApply: [
    "Under this finance company's rules the customer's first payment doesn't offset the unfinanced share, so AutoFlow's calculation doesn't apply to this deal. Record the amount that was actually sent.",
    "وفق قواعد شركة التمويل هذه لا تُخصم الدفعة الأولى للعميل من الجزء غير المموَّل، لذلك لا ينطبق احتساب أوتوفلو على هذه الصفقة. سجِّل المبلغ الذي أُرسل فعلياً.",
  ],
  QuotationUnavailableNoTarget: [
    "AutoFlow has no target selling amount to calculate from for this deal. Record the amount that was actually sent.",
    "لا يتوفّر لأوتوفلو مبلغ بيع مستهدف ليحتسب منه لهذه الصفقة. سجِّل المبلغ الذي أُرسل فعلياً.",
  ],
});
