import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * SCRUM-417: the deal as a wizard — the one next step on every stage, and the
 * one precise reason when this caller cannot take it.
 */
export const dealWizardMessages = defineBilingualMessages({
  // G1 — a DRAFT application.
  SubmitApplicationAction: ["Submit the application", "تقديم الطلب"],
  SubmitApplicationNeedsPermission: [
    "Submitting the application is done by someone with access to finance applications.",
    "يقدّم الطلبَ من يملك صلاحية الوصول إلى طلبات التمويل.",
  ],
  AppSubmittedForDocumentsSuccess: [
    "Application submitted. Collect the required documents next.",
    "تم تقديم الطلب. الخطوة التالية جمع المستندات المطلوبة.",
  ],
  // G6 — the credit approval waits on the paperwork.
  CompleteDocumentsFirstAction: ["Complete the documents first", "أكمل المستندات أولاً"],
  CreditApprovalNeedsDocuments: [
    "The finance company's approval can only be recorded once every required document is verified or waived. A rejection can still be recorded.",
    "لا يمكن تسجيل موافقة شركة التمويل إلا بعد التحقق من كل المستندات المطلوبة أو الإعفاء منها. ويبقى تسجيل الرفض ممكناً.",
  ],
  // G3 — the finance company's decision, one step at a time.
  QuotationNeedsPermission: [
    "The submitted quotation is recorded by someone who can create finance applications.",
    "يسجّل عرض السعر المُرسَل من يملك صلاحية إنشاء طلبات التمويل.",
  ],
  FinanceDecisionNeedsAccess: [
    "The finance company's figures are recorded by someone with access to finance applications.",
    "يسجّل أرقامَ شركة التمويل من يملك صلاحية الوصول إلى طلبات التمويل.",
  ],
  // G5 — the paperwork.
  CompleteDocumentsAction: ["Complete the documents", "إكمال المستندات"],
  DocumentsNeedUploader: [
    "Sales or a Manager uploads the finance documents.",
    "يرفع موظف المبيعات أو المدير مستندات التمويل.",
  ],
  // W1 — every outstanding document is uploaded; only a verifier moves it now.
  DocumentsAwaitVerifier: [
    "Uploaded. A Manager verifies the finance documents.",
    "تم الرفع. يتحقق المدير من مستندات التمويل.",
  ],
  // Round 2 (S417-R2-1): may upload or verify, but cannot read the rows the controls sit on.
  DocumentsNeedReadAccess: [
    "Your role can upload or verify documents but cannot open this deal's document list. Someone with access to finance applications completes them.",
    "يتيح دورك رفع المستندات أو التحقق منها، لكنه لا يتيح فتح قائمة مستندات هذه الصفقة. يُكملها من يملك صلاحية الوصول إلى طلبات التمويل.",
  ],
  // SCRUM-422: a closed or cancelled deal's documents are settled record.
  DocumentsSettled: [
    "This deal is closed or cancelled, so its documents can no longer be changed.",
    "هذه الصفقة مغلقة أو ملغاة، لذا لم يعد بالإمكان تعديل مستنداتها.",
  ],
  // A rejected file is replaced in place; the server swaps the file on the same row.
  ReplaceFile: ["Upload a replacement", "رفع ملف بديل"],
  // Round 3 (S417-R3-1): files kept for requirements removed after the upload — view only.
  DocumentsNoLongerRequired: ["No longer required", "لم تعد مطلوبة"],
  DocumentsNoLongerRequiredNote: [
    "Files uploaded for requirements that have since been removed. Kept for reference; they don't count toward approval.",
    "ملفات رُفعت لمتطلبات أُزيلت لاحقاً. محفوظة للرجوع إليها، ولا تُحتسب في الاعتماد.",
  ],
  RemovedRequirement: ["Removed requirement", "متطلب محذوف"],
  // G7 — the financing reconciliation review.
  // Also the review dialog's title: the button and the dialog it opens say the same thing.
  ResolveReconciliationAction: ["Review the reconciliation note", "مراجعة ملاحظة التسوية"],
  ReconciliationBeforeClose: [
    "A figure on this deal was flagged as unreliable when it was calculated. Record what you checked before closing.",
    "وُسم أحد أرقام هذه الصفقة بأنه غير موثوق عند احتسابه. سجّل ما راجعته قبل الإغلاق.",
  ],
  ReconciliationNeedsPermission: [
    "A Manager or Accountant reviews this deal's reconciliation note.",
    "يراجع المدير أو المحاسب ملاحظة التسوية على هذه الصفقة.",
  ],
  ResolveReconciliationDesc: [
    "Clearing the flag records that someone checked the figures. It changes no amount.",
    "إزالة الوسم تُثبت أن أحداً راجع الأرقام، ولا تغيّر أي مبلغ.",
  ],
  ReconciliationReasonLabel: ["Why it was flagged", "سبب الوسم"],
  ReconciliationNoteLabel: ["What you checked", "ما الذي راجعته"],
  ReconciliationNotePlaceholder: [
    "e.g. Confirmed the approved amount against the finance company's letter",
    "مثال: طابقتُ المبلغ المعتمد مع كتاب شركة التمويل",
  ],
  ReconciliationNoteRequired: [
    "Required — it is the record that the review happened.",
    "مطلوب — فهو السجل الذي يثبت إجراء المراجعة.",
  ],
  ResolveReconciliationConfirm: ["Record the review", "تسجيل المراجعة"],
  // Only what happened: other blockers (route, deposit, readiness, permission) may remain.
  ReconciliationResolved: ["Review recorded.", "سُجّلت المراجعة."],
  FinalizeNeedsHeldDepositResolved: [
    "The finance company pays the supplier directly on this deal, and a reservation deposit is still held. Resolve the deposit from the vehicle's deposit manager, then close.",
    "تدفع شركة التمويل للمورد مباشرةً في هذه الصفقة، وما زال هناك عربون محتجز. عالج العربون من إدارة العربون في صفحة المركبة، ثم أغلق الصفقة.",
  ],
  // G8 — the cash rail.
  CompleteCashSaleAction: ["Complete the sale", "إتمام البيع"],
  // W3 — above the working step: what is outstanding, never "nothing is outstanding".
  StageCashSaleIsDraft: [
    "This sale is still a draft. Complete it to record the sale.",
    "هذا البيع ما زال مسودة. أتمّه لتسجيل البيع.",
  ],
  // W3 — the sale's own dialog saves through edit:sales and completes through create:sales.
  CashSaleCompletionNeedsPermission: [
    "This sale is still a draft. A Manager completes it.",
    "هذا البيع ما زال مسودة. يُتمّه المدير.",
  ],
  // Round 2 (S417-R2-2): the sale form also reads customers, vehicles and team members.
  CashSaleCompletionNeedsReadAccess: [
    "This sale is still a draft. It is completed in the sale form, which also needs access to view customers, vehicles and team members.",
    "هذا البيع ما زال مسودة. يُتمَّم من نموذج البيع، الذي يتطلب أيضاً صلاحية عرض العملاء والمركبات وأعضاء الفريق.",
  ],
  // Round 2 (S417-R2-3, contained) — round 3 (Sonnet S417-R3-1/R3-2): the reason
  // states only what is true (a quote-linked draft with a held reservation
  // deposit) and where it is completed; no claim about the deposit decision.
  CashSaleCompletionNeedsDepositDecision: [
    "This draft sale is linked to a quotation that holds a reservation deposit, so it can't be completed from the deal screen. Open it from the Sales page to complete it.",
    "هذا البيع المسودّة مرتبط بعرض سعر عليه عربون حجز، لذا لا يمكن إتمامه من شاشة الصفقة. افتحه من صفحة المبيعات لإتمامه.",
  ],
  // SCRUM417-R1 — a legacy approval with no quotation: the approval freezes it.
  ApprovedPurchaseFreezesQuotation: [
    "An approved amount is already recorded on this deal, so the quotation it was based on can no longer change. To change the quotation, reopen the approved amount for correction first.",
    "سُجّل مبلغ معتمد على هذه الصفقة، فلم يعد بالإمكان تغيير عرض السعر الذي بُني عليه. لتغيير عرض السعر، أعد فتح المبلغ المعتمد للتصحيح أولاً.",
  ],
  SupplierSettlementNeedsPermission: [
    "An Accountant records the supplier's settlement.",
    "يسجّل المحاسب تسوية المورد.",
  ],
  CashSettlementNotRecordedHere: [
    "The supplier's balance on this sale is still open, and it is not settled from this screen. It closes when accounting records the payment.",
    "رصيد المورد على هذا البيع ما زال مفتوحاً، ولا تتم تسويته من هذه الشاشة. يُغلق عندما تسجّل المحاسبة الدفعة.",
  ],
  // SCRUM-417 UX1 -- dead-end repairs. S2: a blocked handover names its blocker.
  HandoverBlockedNeedsApproval: [
    "Handover is blocked until a Manager records the finance company's approval on this application.",
    "التسليم متوقف إلى أن يسجّل المدير موافقة شركة التمويل على هذا الطلب.",
  ],
  // S4: blockers that live on another page link to it, or say who acts.
  OpenDepositManagerAction: ["Open vehicles to resolve the deposit", "فتح المركبات لمعالجة العربون"],
  DepositManagerNeedsApprover: [
    "A Manager resolves the deposit. Ask a Manager to do it.",
    "يعالج المدير العربون. اطلب منه معالجته.",
  ],
  OpenSalesPageAction: ["Open the Sales page", "فتح صفحة المبيعات"],
  SalesPageNeedsAccess: [
    "A Manager completes this sale from the Sales page.",
    "يُتمّ المدير هذا البيع من صفحة المبيعات.",
  ],
  SupplierPayableRecordedOnPayables: [
    "The dealership collected the full sale price, so the supplier's share is a payable it owes. It is paid from the supplier payables page, not from this screen.",
    "حصّل المعرض كامل سعر البيع، فحصة المورد مستحقة عليه. تُدفع من صفحة مستحقات الموردين، لا من هذه الشاشة.",
  ],
  OpenSourcingPayablesAction: ["Open supplier payables", "فتح مستحقات الموردين"],
  SupplierPayablesNeedFinanceRole: [
    "An Accountant pays supplier payables.",
    "يتولى المحاسب دفع مستحقات الموردين.",
  ],
  ClosingCheckGoToCosts: ["Go to handover costs", "الانتقال إلى رسوم التسليم"],
  ClosingCheckGoToCustody: ["Go to custody", "الانتقال إلى العهدة"],
  // SCRUM-417 UX3 (O1): the step workbench and the collapsed record beneath it.
  DealDetailsHeading: ["Deal details", "تفاصيل الصفقة"],
  DealDetailsHint: ["The rest of this deal's information", "بقية معلومات الصفقة"],
});
