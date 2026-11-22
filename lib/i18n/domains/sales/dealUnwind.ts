import { defineBilingualMessages } from "../../defineBilingualMessages";

export const dealUnwindMessages = defineBilingualMessages({
  // SCRUM-693: unwinding a paid finance deal (convex/utils/dealUnwindMessages.ts).
  ServerError_DEAL_CANCEL_USE_UNWIND: [
    "This deal has a recorded finance-company payment. Open Unwind deal on this page to reverse it before cancelling.",
    "سُجّل استلام دفعة من شركة التمويل لهذه الصفقة. افتح التراجع عن الصفقة من هذه الصفحة لعكسها قبل الإلغاء.",
  ],
  ServerError_DEAL_UNWIND_ACTIVE: [
    "This deal is being unwound. Finish or abandon the unwind on the deal page first. Nothing has been changed.",
    "يجري التراجع عن هذه الصفقة. أكمل التراجع أو تخلَّ عنه من صفحة الصفقة أولاً. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_NOT_FOUND: [
    "The deal or its unwind could not be found. Nothing has been changed.",
    "تعذّر العثور على الصفقة أو على عملية التراجع عنها. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_NOT_ELIGIBLE: [
    "Only a finalized deal whose finance-company payment was received by bank transfer or cash can be unwound here. Nothing has been changed.",
    "لا يمكن التراجع من هنا إلا عن صفقة مكتملة استُلمت دفعة شركة التمويل فيها بتحويل بنكي أو نقداً. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_CHEQUE_DEAL: [
    "This deal was paid by cheque. Record the returned cheque from the deal page instead. Nothing has been changed.",
    "دُفعت هذه الصفقة بشيك. سجّل الشيك المرتجع من صفحة الصفقة بدلاً من ذلك. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_DIRECT_ROUTE: [
    "The finance company paid the supplier directly on this deal, so it cannot be unwound here. An accountant reviews the deal. Nothing has been changed.",
    "دفعت شركة التمويل للمورّد مباشرة في هذه الصفقة، لذلك لا يمكن التراجع عنها من هنا. يراجع المحاسب الصفقة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_SALE_NOT_COMPLETED: [
    "This deal's sale is not completed, so there is nothing to unwind. An accountant reviews the deal. Nothing has been changed.",
    "عملية البيع في هذه الصفقة غير مكتملة، لذلك لا يوجد ما يمكن التراجع عنه. يراجع المحاسب الصفقة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_PERMISSION: [
    "Reversing a paid deal needs both the cancel-closed-deal and the confirm-finance-disbursement permissions. Ask an administrator.",
    "عكس صفقة مدفوعة يتطلب صلاحيتي إلغاء الصفقة المغلقة وتأكيد صرف التمويل معًا. يرجى مراجعة المسؤول.",
  ],
  ServerError_DEAL_UNWIND_COMMISSION_PAID: [
    "The salesperson's commission on this deal has already been paid. Recovering it is not supported yet; an accountant reviews the deal. Nothing has been changed.",
    "صُرفت عمولة مندوب المبيعات على هذه الصفقة. استرداد العمولة غير مدعوم بعد؛ يراجع المحاسب الصفقة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_OPEN_CUSTODY: [
    "An employee still holds cash custody on this deal. Settle that custody record before unwinding the deal. Nothing has been changed.",
    "لا يزال أحد الموظفين يحتفظ بعهدة نقدية على هذه الصفقة. سوِّ سجل العهدة قبل التراجع عن الصفقة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_ALREADY_ACTIVE: [
    "An unwind of this deal is already in progress. Continue it on the deal page. Nothing has been changed.",
    "توجد عملية تراجع عن هذه الصفقة قيد التنفيذ. تابعها من صفحة الصفقة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_REASON_REQUIRED: [
    "Give the reason for this step. Nothing has been changed.",
    "اذكر سبب هذه الخطوة. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_TEXT_TOO_LONG: [
    "One of the entered texts is too long. Shorten it and try again. Nothing has been changed.",
    "أحد النصوص المدخلة طويل جداً. اختصره وحاول مرة أخرى. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_NOT_ACTIVE: [
    "This unwind is already finished or abandoned. Nothing has been changed.",
    "عملية التراجع هذه مكتملة أو متروكة بالفعل. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_STEP_DONE: [
    "This step of the unwind is already recorded. Nothing has been changed.",
    "هذه الخطوة من التراجع مسجّلة بالفعل. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_FORWARD_NOT_APPLICABLE: [
    "Nothing was paid to the finance company on this deal, so there is no return to record. Continue with the refund. Nothing has been changed.",
    "لم يُدفع أي مبلغ لشركة التمويل في هذه الصفقة، لذلك لا يوجد استرداد لتسجيله. تابع إلى ردّ المبلغ. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_FORWARD_UNSETTLED: [
    "The payment to the finance company is not settled on the books. An accountant resolves it before the unwind can continue. Nothing has been changed.",
    "المبلغ المدفوع لشركة التمويل غير مُسوّى في الدفاتر. يعالجه المحاسب قبل متابعة التراجع. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_FORWARD_REVERSAL_UNPROVEN: [
    "The return of the payment to the finance company could not be confirmed as posted on the books, so it was not recorded. Nothing has been changed. An accountant reviews the deal.",
    "تعذّر التأكد من ترحيل استرداد المبلغ المدفوع لشركة التمويل في الدفاتر، لذلك لم يُسجَّل. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_DEAL_UNWIND_PERIOD_NOT_OPEN: [
    "Today's accounting period is not open, so the reversal cannot be posted now. An accountant opens the period first. Nothing has been changed.",
    "الفترة المحاسبية لتاريخ اليوم غير مفتوحة، لذلك لا يمكن ترحيل العكس الآن. يفتح المحاسب الفترة أولاً. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_FORWARD_FIRST: [
    "Record and settle the finance company's return of the forwarded payment before continuing.",
    "سجّل استرداد المبلغ المدفوع لشركة التمويل وسوِّ قيده قبل المتابعة.",
  ],
  ServerError_DEAL_UNWIND_EVIDENCE_REQUIRED: [
    "Enter the required reference: the bank reference for a transfer, or the voucher number and the recipient's acknowledgement for cash. Nothing has been changed.",
    "أدخل المرجع المطلوب: المرجع البنكي للتحويل، أو رقم السند وإقرار المستلم للدفع النقدي. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_INVALID_DATE: [
    "The date must be a real date and cannot be in the future. Nothing has been changed.",
    "يجب أن يكون التاريخ صحيحاً وألا يكون في المستقبل. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_REFUND_METHOD_MISMATCH: [
    "The refund must go back the same way the finance company's payment was received (bank transfer or cash). Nothing has been changed.",
    "يجب ردّ المبلغ بالطريقة نفسها التي استُلمت بها دفعة شركة التمويل (تحويل بنكي أو نقداً). لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_STALE: [
    "The deal's recorded payment changed since this unwind started. Abandon this unwind and start again. Nothing has been changed.",
    "تغيّرت الدفعة المسجّلة على الصفقة منذ بدء هذا التراجع. تخلَّ عن هذا التراجع وابدأ من جديد. لم يتم تغيير أي شيء.",
  ],
  ServerError_DEAL_UNWIND_CHAIN_MISMATCH: [
    "The finance company's payment does not match the deal's recorded receipt (amount, date, currency or payer). Nothing has been changed. An accountant reviews the deal.",
    "دفعة شركة التمويل لا تطابق الاستلام المسجَّل على الصفقة (المبلغ أو التاريخ أو العملة أو الدافع). لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_DEAL_UNWIND_ALLOCATION_SHAPE: [
    "The finance company's payment is not allocated exactly to this deal's receivable, so it cannot be reversed safely. Nothing has been changed. An accountant reviews the deal.",
    "دفعة شركة التمويل غير موزَّعة بالكامل على ذمة هذه الصفقة، لذلك لا يمكن عكسها بأمان. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_DEAL_UNWIND_REVERSAL_UNPROVEN: [
    "The finance company's receipt could not be confirmed as reversed on the books, so the refund was not recorded. Nothing has been changed. An accountant reviews the deal.",
    "تعذّر التأكد من عكس قيد استلام مبلغ شركة التمويل في الدفاتر، لذلك لم يُسجَّل الردّ. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_DEAL_UNWIND_DISPOSITION_REQUIRED: [
    "Choose what happens to the customer's payment (refund or keep as credit) and fill in the credit note and the vehicle return. Nothing has been changed.",
    "اختر ما يحدث لدفعة العميل (ردّها أو الاحتفاظ بها كرصيد دائن) وأكمل إشعار الدائن وإرجاع المركبة. لم يتم تغيير أي شيء.",
  ],
  // SCRUM-693 / SCRUM-691: the Unwind deal dialog and its entry point.
  UnwindDealAction: [
    "Unwind deal",
    "التراجع عن الصفقة",
  ],
  UnwindDealResume: [
    "Continue unwind",
    "متابعة التراجع",
  ],
  UnwindDealTitle: [
    "Unwind this deal",
    "التراجع عن هذه الصفقة",
  ],
  UnwindDealDesc: [
    "Reverse a deal the finance company has already paid, step by step. Each step is recorded and can be continued later.",
    "عكس صفقة دفعت شركة التمويل قيمتها، خطوة بخطوة. تُسجَّل كل خطوة ويمكن متابعتها لاحقًا.",
  ],
  UnwindStepsLabel: [
    "Unwind steps",
    "خطوات التراجع",
  ],
  UnwindStepStart: [
    "Reason",
    "السبب",
  ],
  UnwindStepForward: [
    "Finance-company return",
    "استرداد شركة التمويل",
  ],
  UnwindStepFinish: [
    "Refund and vehicle",
    "الردّ والمركبة",
  ],
  UnwindStartExplain: [
    "Record why this deal is being reversed. Nothing is posted yet.",
    "سجّل سبب التراجع عن هذه الصفقة. لا يُرحَّل أي قيد بعد.",
  ],
  UnwindReasonLabel: [
    "Reason",
    "السبب",
  ],
  UnwindStartAction: [
    "Start unwind",
    "بدء التراجع",
  ],
  UnwindForwardExplain: [
    "Record the finance company's return of the payment the dealership forwarded to it. The return must be settled before the refund.",
    "سجّل استرداد المبلغ الذي دفعته المنشأة لشركة التمويل. يجب تسوية الاسترداد قبل الردّ.",
  ],
  UnwindForwardDueLabel: [
    "Amount to be returned",
    "المبلغ المطلوب استرداده",
  ],
  UnwindForwardDateLabel: [
    "Date returned",
    "تاريخ الاسترداد",
  ],
  UnwindForwardReferenceLabel: [
    "Reference of the return",
    "مرجع الاسترداد",
  ],
  UnwindForwardAction: [
    "Record return",
    "تسجيل الاسترداد",
  ],
  UnwindFinishExplain: [
    "Refund the full amount the finance company paid, issue the credit note and take the vehicle back. The vehicle goes to inspection before it can be sold again.",
    "ردّ كامل المبلغ الذي دفعته شركة التمويل، وأصدر إشعار الدائن، واستلم المركبة. تدخل المركبة الفحص قبل أن يمكن بيعها مجددًا.",
  ],
  UnwindRefundAmountLabel: [
    "Refund to the finance company",
    "المبلغ المردود لشركة التمويل",
  ],
  UnwindMethodBank: [
    "bank transfer",
    "تحويل بنكي",
  ],
  UnwindMethodCash: [
    "cash",
    "نقدًا",
  ],
  UnwindRefundDateLabel: [
    "Date refunded",
    "تاريخ الردّ",
  ],
  UnwindBankReferenceLabel: [
    "Bank reference",
    "المرجع البنكي",
  ],
  UnwindVoucherLabel: [
    "Voucher number",
    "رقم السند",
  ],
  UnwindAcknowledgedLabel: [
    "The recipient acknowledged receiving the cash",
    "أقرّ المستلم باستلام المبلغ نقدًا",
  ],
  UnwindCreditNoteLabel: [
    "Credit note reference",
    "مرجع إشعار الدائن",
  ],
  UnwindVehicleDateLabel: [
    "Date the vehicle was returned",
    "تاريخ إرجاع المركبة",
  ],
  UnwindVehicleNoteLabel: [
    "Vehicle condition on return",
    "حالة المركبة عند الإرجاع",
  ],
  UnwindVehicleInspectionNote: [
    "The vehicle is held for inspection. It returns to sale only after an authorized user clears it.",
    "تبقى المركبة قيد الفحص. لا تعود للبيع إلا بعد أن يُجيزها مستخدم مخوَّل.",
  ],
  UnwindDispositionLabel: [
    "The customer's own payment",
    "دفعة العميل نفسه",
  ],
  UnwindDispositionPlaceholder: [
    "Choose what happens to it",
    "اختر ما يحدث لها",
  ],
  UnwindDispositionRefund: [
    "Mark it to be refunded to the customer (paid out separately)",
    "تحديدها للردّ للعميل (يُصرف الردّ بشكل منفصل)",
  ],
  UnwindDispositionRefundPayout: [
    "Record a separate customer payout",
    "تسجيل صرف مستقل للعميل",
  ],
  UnwindCustomerPayoutUnavailable: [
    "Paying this customer credit out is not available yet. Keep it as customer credit.",
    "صرف رصيد العميل غير متاح حاليًا. احتفظ به كرصيد دائن للعميل.",
  ],
  UnwindDispositionCredit: [
    "Keep it as customer credit",
    "الاحتفاظ بها كرصيد دائن للعميل",
  ],
  UnwindCustomerCreditLabel: [
    "Customer credit applied to this sale",
    "رصيد العميل المستخدم في هذا البيع",
  ],
  UnwindCustomerPayoutTitle: [
    "Customer payout details",
    "تفاصيل المبلغ المصروف للعميل",
  ],
  UnwindCustomerPayoutAmountLabel: [
    "Amount paid to customer",
    "المبلغ المصروف للعميل",
  ],
  UnwindCustomerPayoutMethodLabel: [
    "Customer payout method",
    "طريقة الصرف للعميل",
  ],
  UnwindCustomerPayoutReferenceLabel: [
    "Customer payout reference",
    "مرجع الصرف للعميل",
  ],
  UnwindCustomerPayoutDateLabel: [
    "Customer payout date",
    "تاريخ الصرف للعميل",
  ],
  UnwindFinishAction: [
    "Refund and reverse the sale",
    "ردّ المبلغ وعكس البيع",
  ],
  UnwindAbandonAction: [
    "Abandon this unwind",
    "التخلي عن هذا التراجع",
  ],
  UnwindAbandonExplain: [
    "Stop this unwind and leave the deal as it is. Anything already recorded stays recorded.",
    "أوقف هذا التراجع واترك الصفقة كما هي. ما سُجِّل مسبقًا يبقى مسجّلًا.",
  ],
  UnwindAbandonConfirm: [
    "Abandon unwind",
    "تأكيد التخلي",
  ],
  UnwindPaidDealBanner: [
    "This deal has been paid by the finance company. Use Unwind deal to record the returned forward, refund the full remittance, and reverse the sale.",
    "دفعت شركة التمويل قيمة هذه الصفقة. استخدم التراجع عن الصفقة لتسجيل استرداد المبلغ المحوّل للشركة، وردّ كامل المبلغ المستلم منها، ثم عكس البيع.",
  ],
  UnwindInProgressBadge: [
    "Unwinding",
    "قيد التراجع",
  ],
  UnwindStartedSuccess: [
    "Unwind started.",
    "بدأ التراجع عن الصفقة.",
  ],
  UnwindForwardRecordedSuccess: [
    "The finance company's return was recorded.",
    "سُجّل استرداد شركة التمويل.",
  ],
  UnwindFinishedSuccess: [
    "The deal was unwound: the refund and the vehicle return are recorded.",
    "تم التراجع عن الصفقة: سُجّل الردّ وإرجاع المركبة.",
  ],
  UnwindAbandonedSuccess: [
    "The unwind was abandoned.",
    "تم التخلي عن التراجع.",
  ],
});
