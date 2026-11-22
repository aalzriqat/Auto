import { defineBilingualMessages } from "../../defineBilingualMessages";

export const settlementErrorMessages = defineBilingualMessages({
  // SCRUM-766 PR-C follow-up. The English text must equal SUPPLIER_CONCESSION_REFUSALS.NOT_CURRENT_PLAN
  // in convex/utils/supplierConcession.ts.
  ServerError_SUPPLIER_CONCESSION_PLAN_REFUSED: [
    "A supplier concession can be recorded only on a deal that is financed through a finance company and closes on the current sale plan. This deal does not, so the shortfall cannot be placed on the supplier.",
    "لا يمكن تسجيل تنازل المورّد إلا على صفقة ممولة عبر شركة تمويل وتُغلق وفق خطة البيع الحالية. هذه الصفقة ليست كذلك، لذا لا يمكن تحميل الفرق على المورّد.",
  ],
  ServerError_COMMISSION_BASE_UNUSABLE: [
    "This deal's financing figures (recorded in {baseCurrency}) cannot be used to work out the commissionable vehicle margin in the dealership's currency ({orgCurrency}). Settle the deal's currency and figures before completing it.",
    "لا يمكن استخدام أرقام التمويل لهذه الصفقة (المسجلة بعملة {baseCurrency}) لاحتساب هامش المركبة الخاضع للعمولة بعملة المعرض ({orgCurrency}). يرجى تسوية عملة الصفقة وأرقامها قبل إتمامها.",
  ],
  ServerError_FINANCED_SALE_REQUIRES_DEAL: [
    "A financed sale can only be created through the deal, with its finance application. Start the deal from the quote instead of recording a financed sale directly.",
    "لا يمكن تسجيل عملية بيع بالتمويل مباشرة؛ فعملية البيع الممولة تُنشأ فقط من خلال الصفقة مع طلب التمويل الخاص بها. ابدأ الصفقة من عرض السعر بدلاً من تسجيل بيع ممول بشكل مباشر.",
  ],
  ServerError_SALE_COMPLETES_THROUGH_FINANCE_APPLICATION: [
    "This car has a finance application in progress. Complete the sale from the deal page.",
    "هذه السيارة عليها طلب تمويل قيد المعالجة. أكمل البيع من صفحة الصفقة.",
  ],
  ServerError_QUOTE_ECONOMICS_DRIFTED: [
    "The quotation's pricing no longer matches the pricing frozen on this finance application, so the deal cannot be finalized. Cancel the finance application and start again from a new quotation.",
    "لم يعد تسعير عرض السعر مطابقاً للتسعير المثبت في طلب التمويل، لذلك لا يمكن إتمام الصفقة. ألغِ طلب التمويل وابدأ من عرض سعر جديد.",
  ],
  ServerError_COMMISSION_BASE_UNUSABLE_RECALC: [
    "This sale's recorded commissionable margin is in a different currency from the organization's or holds an unusable amount, so a commission cannot be worked out. Have the deal's figures corrected before recalculating; the existing commission has been left untouched.",
    "هامش المركبة الخاضع للعمولة المسجل لعملية البيع هذه بعملة مختلفة عن عملة المؤسسة أو يحتوي على مبلغ غير صالح، لذا لا يمكن احتساب العمولة. يرجى تصحيح أرقام الصفقة قبل إعادة الاحتساب؛ لم يتم تغيير العمولة الحالية.",
  ],
  ServerError_FINANCE_RETURN_NOT_DISBURSED: [
    "This deal has no confirmed finance-company disbursement, so there is no cleared cheque to return. Nothing has been changed.",
    "لا يوجد صرف مؤكد من شركة التمويل لهذه الصفقة، لذلك لا يوجد شيك مصروف ليُسجَّل كمرتجع. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_CHEQUE_NOT_CLEARED: [
    "Only a cleared finance-company cheque can be returned from the deal, and this cheque is not cleared. Nothing has been changed.",
    "لا يمكن تسجيل إرجاع شيك شركة التمويل من شاشة الصفقة إلا إذا كان قد تم صرفه، وهذا الشيك لم يُصرف بعد. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_CHAIN_MISMATCH: [
    "This cheque does not match the deal's recorded disbursement (the cheque, amount, currency or payment). Nothing has been changed. An accountant reviews the deal.",
    "هذا الشيك لا يطابق صرف التمويل المسجَّل على الصفقة (الشيك أو المبلغ أو العملة أو الدفعة). لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_FINANCE_RETURN_ALLOCATION_SHAPE: [
    "The disbursement payment is not allocated exactly to this deal's finance-company receivable, so it cannot be reversed safely. Nothing has been changed. An accountant reviews the deal.",
    "دفعة صرف التمويل غير موزَّعة بالكامل على ذمة شركة التمويل الخاصة بهذه الصفقة، لذلك لا يمكن عكسها بأمان. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_FINANCE_RETURN_REVERSAL_UNPROVEN: [
    "The finance company's receipt could not be confirmed as reversed on the books, so the return was not recorded. Nothing has been changed. An accountant reviews the deal.",
    "تعذّر التأكد من عكس قيد استلام مبلغ شركة التمويل في الدفاتر، لذلك لم يُسجَّل المرتجع. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_FINANCE_RETURN_REASON_REQUIRED: [
    "Give the reason the bank returned the cheque. Nothing has been changed.",
    "اكتب سبب إرجاع البنك للشيك. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_REASON_TOO_LONG: [
    "The return reason is too long (the most is {max} characters). Nothing has been changed.",
    "سبب الإرجاع طويل جدًا (الحد الأقصى {max} حرفًا). لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CHEQUE_RETURN_FROM_DEAL: [
    "This is a finance-company cheque. Its return is recorded from the deal screen with the \"Cheque returned by bank\" action, not from customer collections. Nothing has been changed.",
    "هذا شيك شركة تمويل، ويُسجَّل إرجاعه من شاشة الصفقة عبر إجراء «شيك مرتجع من البنك» وليس من تحصيلات العملاء. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_NOT_FOUND: [
    "The deal or the cheque could not be found. Nothing has been changed.",
    "تعذّر العثور على الصفقة أو الشيك. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_KEY_CONFLICT: [
    "This request reuses the identity of an earlier request that had different content (another cheque or reason). Nothing has been changed. Reopen the dialog and try again.",
    "يعيد هذا الطلب استخدام معرّف طلب سابق كان محتواه مختلفًا (شيك أو سبب آخر). لم يتم تغيير أي شيء. أعد فتح النافذة وحاول مرة أخرى.",
  ],
  ServerError_CHEQUE_ALREADY_RETURNED: [
    "This cheque has already been returned, so it cannot be returned again. Nothing has been changed.",
    "سبق تسجيل هذا الشيك كمرتجع، لذلك لا يمكن إرجاعه مرة أخرى. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_NOT_RETURNABLE: [
    "This cheque can no longer be returned. Nothing has been changed.",
    "لا يمكن إرجاع هذا الشيك بعد الآن. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER: [
    "This cheque belongs to a cancelled sale and was not presented to the bank. Return it to the customer. Nothing has been changed.",
    "هذا الشيك يخص صفقة ملغاة ولم يُقدَّم إلى البنك. أعده إلى العميل. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_RETURN_AFTER_CREDIT_REFUND: [
    "Part of this cheque's credit has already been refunded to the customer, so the cheque cannot be returned after clearing. Nothing has been changed. An accountant reviews the case.",
    "سبق ردّ جزء من رصيد هذا الشيك إلى العميل، لذلك لا يمكن إرجاع الشيك بعد صرفه. لم يتم تغيير أي شيء. يراجع المحاسب الحالة.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_INVALID_AMOUNT: [
    "Enter a refund amount greater than zero, in whole minor currency units. Nothing has been changed.",
    "أدخل مبلغ ردّ أكبر من صفر بوحدات العملة الصغرى الكاملة. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_INSUFFICIENT: [
    "The refund is larger than the customer credit that is still available (credit reserved for a sale invoice or already requested is not available). Nothing has been changed.",
    "مبلغ الردّ أكبر من رصيد العميل المتاح (الرصيد المحجوز لفاتورة بيع أو المطلوب ردّه سابقًا غير متاح). لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_NOT_FOUND: [
    "Refund request or customer credit not found. Nothing has been changed.",
    "لم يتم العثور على طلب الردّ أو رصيد العميل. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_NOT_PENDING: [
    "This refund request has already been decided. Nothing has been changed.",
    "سبق البتّ في طلب الردّ هذا. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_NOT_APPROVED: [
    "This refund request is not approved, or has already been paid. Nothing has been changed.",
    "طلب الردّ هذا غير معتمد أو سبق دفعه. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_RECEIPT_UNPOSTED: [
    "The original receipt has not reached the general ledger yet, so its credit cannot be refunded. Nothing has been changed.",
    "لم يصل سند القبض الأصلي إلى دفتر الأستاذ العام بعد، لذلك لا يمكن ردّ رصيده. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_PAYOUT_INVALID: [
    "Enter the payout reference (at most 120 characters) and a payout date that is not in the future. Nothing has been changed.",
    "أدخل مرجع الدفع (120 حرفًا كحد أقصى) وتاريخ دفع ليس في المستقبل. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_POSTING_FAILED: [
    "The refund could not be posted to the general ledger, so nothing was paid or changed.",
    "تعذّر ترحيل الردّ إلى دفتر الأستاذ العام، لذلك لم يُدفع أو يُغيَّر أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_UNAVAILABLE: [
    "That much customer credit is not available: part of it is reserved for a sale invoice or already requested as a refund. Nothing has been changed.",
    "مبلغ رصيد العميل المطلوب غير متاح: جزء منه محجوز لفاتورة بيع أو مطلوب ردّه مسبقًا. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_NOT_CANCELLABLE: [
    "Only a pending or approved refund request can be cancelled. Nothing has been changed.",
    "لا يمكن إلغاء إلا طلب ردّ معلّق أو معتمد. لم يتم تغيير أي شيء.",
  ],
  ServerError_RETAINED_CREDIT_REFUND_CANCEL_REASON_REQUIRED: [
    "Give a reason of at most 500 characters to cancel this refund request. Nothing has been changed.",
    "اذكر سببًا (500 حرف كحد أقصى) لإلغاء طلب الردّ هذا. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_INVOICE_UNCOVERED_HELD: [
    "This sale's invoice can no longer cover the cheque, so it cannot be deposited. Return it to the customer. Nothing has been changed.",
    "لم تعد فاتورة هذه الصفقة تغطي الشيك، لذلك لا يمكن إيداعه. أعده إلى العميل. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_NOT_FOUND: [
    "Cheque not found. Nothing has been changed.",
    "لم يتم العثور على الشيك. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_NOT_CLEARED: [
    "Only cleared cheques can be returned after clearing. Nothing has been changed.",
    "لا يمكن إرجاع الشيك بعد التصفية إلا إذا كان الشيك مصفّى. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_RETURN_KEY_INVALID: [
    "The request identity is missing or too long (at most 200 characters). Nothing has been changed. Reopen the dialog and try again.",
    "معرّف الطلب مفقود أو أطول من الحد المسموح (200 حرف كحد أقصى). لم يتم تغيير أي شيء. أعد فتح النافذة وحاول مرة أخرى.",
  ],
  ServerError_FINANCE_CONFIRM_STALE_REQUEST: [
    "This confirmation was prepared before the deal's cheque was returned, so it cannot be applied. Nothing has been changed. Reopen the deal and confirm again.",
    "جرى تجهيز هذا التأكيد قبل إرجاع شيك الصفقة، لذلك لا يمكن تطبيقه. لم يتم تغيير أي شيء. أعد فتح الصفقة وأكّد من جديد.",
  ],
  ServerError_FINANCE_CONFIRM_ALREADY_CONFIRMED: [
    "Disbursement has already been confirmed for this application. Nothing has been changed.",
    "تم تأكيد الصرف لهذا الطلب مسبقًا. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED: [
    "This deal's cheque is already marked cleared but the disbursement was never confirmed. Ask accounting to review it before confirming. Nothing has been changed.",
    "شيك هذه الصفقة مُعلَّم كمصفّى بالفعل لكن الصرف لم يُؤكَّد قط. اطلب من المحاسبة مراجعته قبل التأكيد. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED: [
    "This cheque was returned or cancelled. Correct the expected payment, then register the new payment, before confirming disbursement. Nothing has been changed.",
    "تم إرجاع هذا الشيك أو إلغاؤه. صحّح الدفعة المتوقعة ثم سجّل الدفعة الجديدة قبل تأكيد الصرف. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_CHEQUE_NOT_FOUND: [
    "Expected cheque record not found for this application. Nothing has been changed.",
    "لم يتم العثور على سجل الشيك المتوقع لهذا الطلب. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES: [
    "This deal has more than one live finance-company cheque. Resolve the duplicate before confirming disbursement. Nothing has been changed.",
    "لهذه الصفقة أكثر من شيك واحد فعّال لشركة التمويل. عالج التكرار قبل تأكيد الصرف. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED: [
    "This cheque's face amount was never recorded in minor units. Have a finance manager attest the face from the deal before confirming disbursement. Nothing has been changed.",
    "لم يُسجَّل المبلغ المكتوب على هذا الشيك بالوحدات الصغرى قط. اطلب من مدير مالي إقرار المبلغ من الصفقة قبل تأكيد الصرف. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH: [
    "The cheque's recorded face does not equal the disbursement being confirmed. Correct the expected payment or the cheque before confirming. Nothing has been changed.",
    "المبلغ المسجَّل على الشيك لا يساوي مبلغ الصرف الذي يتم تأكيده. صحّح الدفعة المتوقعة أو الشيك قبل التأكيد. لم يتم تغيير أي شيء.",
  ],
  ServerError_FINANCE_CONFIRM_NO_FINANCIER_PAYS: [
    "No finance company pays the dealership on this deal, so there is no disbursement to confirm.",
    "لا تدفع أي شركة تمويل للمعرض في هذه الصفقة، لذلك لا يوجد صرف لتأكيده.",
  ],
  ServerError_FINANCE_CONFIRM_NO_FINANCE_COMPANY: [
    "This application has no finance company — no disbursement expected.",
    "لا توجد شركة تمويل لهذا الطلب، ولا يُتوقَّع أي صرف.",
  ],
  ServerError_CHEQUE_BANK_FEE_INVALID: [
    "The bank fee must be a whole, non-negative amount in minor currency units. Nothing has been changed.",
    "يجب أن تكون رسوم البنك عددًا صحيحًا غير سالب بالوحدات الصغرى للعملة. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_CLEAR_BANK_INVALID: [
    "Select an active bank account in this organization's currency to clear the cheque. Nothing has been changed.",
    "اختر حسابًا مصرفيًا نشطًا بعملة هذه المؤسسة لتصفية الشيك. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_RETURN_FEE_BANK_INVALID: [
    "Select an active bank account in this organization's currency for the return fee. Nothing has been changed.",
    "اختر حسابًا مصرفيًا نشطًا بعملة هذه المؤسسة لدفع رسوم إرجاع الشيك. لم يتم تغيير أي شيء.",
  ],
  ServerError_CHEQUE_RETURN_NO_RECEIPT_LINEAGE: [
    "This cleared cheque has no persisted receipt lineage, so what it moved cannot be determined, and returning it would reopen the debt without reversing the receipt. Nothing has been changed. An accountant reviews the deal.",
    "لا يوجد سجل محفوظ لقيد الاستلام المرتبط بهذا الشيك المصفّى، لذلك لا يمكن تحديد ما حرّكه، وإرجاعه سيعيد فتح الدين دون عكس الاستلام. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_CHEQUE_RETURN_NO_PAYMENT_TO_REVERSE: [
    "This cleared cheque has no collection payment to reverse, so reopening the debt would leave it owed and collected at the same time. Nothing has been changed. An accountant reviews the deal.",
    "لا توجد دفعة تحصيل لهذا الشيك المصفّى ليتم عكسها، وإعادة فتح الدين ستجعله مستحقًا ومحصّلًا في الوقت نفسه. لم يتم تغيير أي شيء، ويراجع المحاسب الصفقة.",
  ],
  ServerError_CHEQUE_RETURN_KEY_CONFLICT: [
    "This same request was already sent with a different cheque, reason, bank fee or bank account. Nothing has been changed. Close and reopen the dialog to try again.",
    "سبق إرسال هذا الطلب نفسه مع شيك أو سبب أو رسوم بنكية أو حساب مصرفي مختلف. لم يتم تغيير أي شيء. أغلق النافذة وأعد فتحها للمحاولة مرة أخرى.",
  ],
});
