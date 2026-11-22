import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * SCRUM-724 mount: the deal-page receipts panel and the Collections refund queue
 * degrade to these when their own queries fail, and the panel explains a held
 * cheque the invoice can no longer cover before the server has to refuse it.
 */
export const customerMoneyMountMessages = defineBilingualMessages({
  DealReceiptPanelLoadFailed: [
    "Customer money for this sale could not be loaded. The rest of the deal is unaffected. Reload the page to try again.",
    "تعذّر تحميل أموال العميل لهذه الصفقة. باقي الصفقة لم يتأثر. أعد تحميل الصفحة للمحاولة مجدداً.",
  ],
  RetainedCreditRefundsLoadFailed: [
    "Customer credit refunds could not be loaded. Reload the page to try again.",
    "تعذّر تحميل طلبات ردّ رصيد العملاء. أعد تحميل الصفحة للمحاولة مجدداً.",
  ],
  DealReceiptChequeExceedsInvoice: [
    "The invoice can no longer cover this cheque, so it cannot be deposited. Return it to the customer.",
    "لم تعد الفاتورة تغطي هذا الشيك، لذلك لا يمكن إيداعه. أعده إلى العميل.",
  ],
  // Always true: the server reserves for the invoice only on a live intent with
  // the doors open, so the notice must not claim a reservation (review F1).
  DealReceiptChequeClearedToCredit: [
    "Cheque cleared. Its amount is now customer credit; see the credit and any pending invoice application below.",
    "حُصّل الشيك. أصبح مبلغه رصيداً للعميل؛ راجع الرصيد وأي تطبيق معلّق على الفاتورة أدناه.",
  ],
  // An uncoded or untranslated refusal on the refund queue (review R1/F2).
  RetainedCreditRefundActionFailed: [
    "The refund action could not be completed. Reload the page to see its current status, then try again.",
    "تعذّر إتمام إجراء ردّ الرصيد. أعد تحميل الصفحة لرؤية حالته الحالية، ثم حاول مجدداً.",
  ],
});

/**
 * SCRUM-831: the approver's own queue of customer-credit refund requests on the
 * Approvals page. A manager decides here without the finance ledger; recording the
 * payout stays in Accounting, so no payout wording belongs to this surface.
 */
export const refundApprovalQueueMessages = defineBilingualMessages({
  RefundApprovalQueueTitle: [
    "Customer credit refunds awaiting approval",
    "طلبات ردّ رصيد العملاء بانتظار الموافقة",
  ],
  RefundApprovalQueueDesc: [
    "Finance asked to pay customer credit back. Approve or reject each request; recording the payout stays in Accounting.",
    "طلبت المالية ردّ رصيد عميل. وافق على كل طلب أو ارفضه؛ أما تسجيل الدفع فيبقى في المحاسبة.",
  ],
  RefundApprovalQueueLoading: [
    "Loading refund requests…",
    "جارٍ تحميل طلبات الردّ…",
  ],
  RefundApprovalQueueEmpty: [
    "No customer credit refunds are waiting for your approval.",
    "لا توجد طلبات ردّ أرصدة بانتظار موافقتك.",
  ],
  RefundApprovalOwnRequest: [
    "You requested this refund, so a different approver must decide it.",
    "أنت من قدّم طلب الردّ هذا، لذلك يجب أن يبتّ فيه موافق آخر.",
  ],
  RefundApprovalPaused: [
    "Approving is paused: paying customer credit out is not available during the pilot. The credit stays on the customer's account. You can still reject a request.",
    "الموافقة متوقفة: دفع أرصدة العملاء غير متاح خلال المرحلة التجريبية. يبقى الرصيد في حساب العميل. ما زال بإمكانك رفض الطلب.",
  ],
  RefundApprovalLoadMore: ["Load more requests", "تحميل المزيد من الطلبات"],
  RefundApprovalLoadingMore: ["Loading more requests…", "جارٍ تحميل المزيد من الطلبات…"],
  RefundApprovalRequestedBy: ["Requested by", "مقدّم الطلب"],
  RefundApprovalRequestedOn: ["on", "بتاريخ"],
});
